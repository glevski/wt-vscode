// Holds what `wt list --json` last said about this window's repository and
// decides when to ask again.

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { Cli, WtError, execText } from "./cli";
import { ListDoc, Peek, Worktree, isSyncing } from "./model";

/** Everything the UI needs once the worktrees are known. */
export interface View {
  doc: ListDoc;
  /** The folder this window has open. */
  folder: vscode.Uri;
  /** Where wt commands run: the folder, or a peek's source worktree. */
  cwd: string;
  /** Set when this window has a peek open rather than a worktree. */
  peek?: Peek;
}

export type State =
  | { kind: "loading" | "nofolder" | "missing" | "outdated" | "norepo" }
  | { kind: "error"; message: string }
  | { kind: "ready"; view: View };

const peekMarker = ".wt-peek";

/** A peek directory has no git repository; its marker names where it came from. */
function peekSource(folder: string): string | undefined {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(folder, peekMarker), "utf8")) as { source?: unknown };
    return typeof info.source === "string" && info.source !== "" ? info.source : undefined;
  } catch {
    return undefined;
  }
}

/** A path on the machine the repository lives on, as a URI this window can open. */
export function toUri(folder: vscode.Uri, fsPath: string): vscode.Uri {
  // keeps the folder's scheme and authority, so it also works over SSH and
  // in dev containers, where a bare file: URI would mean the local machine
  return folder.with({ path: vscode.Uri.file(fsPath).path });
}

export class Store implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<State>();
  readonly onDidChange = this.changed.event;
  private readonly refreshed = new vscode.EventEmitter<void>();
  /** Fires after every refresh, changed or not — for data that rides along, like snapshots. */
  readonly onDidRefresh = this.refreshed.event;

  private current: State = { kind: "loading" };
  private fingerprint = "";
  private pending: Promise<void> | undefined;
  private again = false;
  private timer: NodeJS.Timeout | undefined;
  private poll: NodeJS.Timeout | undefined;
  private watchKey = "";
  private watchers: vscode.Disposable[] = [];
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly cli: Cli,
    private readonly log: (line: string) => void,
  ) {
    this.subscriptions.push(
      this.changed,
      this.refreshed,
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) {
          this.schedule();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.schedule(0)),
      // a save can turn a clean worktree dirty
      vscode.workspace.onDidSaveTextDocument(() => this.schedule(1000)),
      // wt and git typed in the integrated terminal change things too
      vscode.window.onDidEndTerminalShellExecution(() => this.schedule()),
    );
  }

  get state(): State {
    return this.current;
  }

  /** The view when ready, undefined otherwise. */
  get view(): View | undefined {
    return this.current.kind === "ready" ? this.current.view : undefined;
  }

  /** Refreshes soon; calls in quick succession collapse into one. */
  schedule(delay = 400): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, delay);
  }

  /** Refreshes now; resolves once the state reflects a list taken after the call. */
  refresh(): Promise<void> {
    if (this.pending !== undefined) {
      this.again = true;
      return this.pending;
    }
    this.pending = (async () => {
      try {
        do {
          this.again = false;
          this.set(await this.load());
        } while (this.again);
      } finally {
        this.pending = undefined;
      }
    })();
    return this.pending;
  }

  private async load(): Promise<State> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (folder === undefined) {
      return { kind: "nofolder" };
    }
    const source = peekSource(folder.fsPath);
    const cwd = source ?? folder.fsPath;
    if (!fs.existsSync(cwd)) {
      return { kind: "norepo" };
    }
    try {
      const doc = await this.cli.list(cwd);
      const view: View = { doc, folder, cwd };
      if (source !== undefined) {
        // the list was taken from the peek's source; this window is the peek
        view.peek = doc.peeks.find((p) => p.path === folder.fsPath);
        doc.worktrees.forEach((w) => (w.current = false));
      }
      return { kind: "ready", view };
    } catch (err) {
      if (err instanceof WtError && err.kind !== "failed") {
        return { kind: err.kind };
      }
      const message = err instanceof Error ? err.message : String(err);
      this.log(`list failed: ${message}`);
      return { kind: "error", message };
    }
  }

  private set(state: State): void {
    const fingerprint = JSON.stringify(state.kind === "ready" ? [state.view.doc, state.view.cwd] : state);
    this.current = state;
    void vscode.commands.executeCommand("setContext", "wt.state", state.kind);

    if (this.poll !== undefined) {
      clearTimeout(this.poll);
      this.poll = undefined;
    }
    if (state.kind === "ready") {
      void this.watch(state.view);
      const { worktrees, peeks } = state.view.doc;
      if (worktrees.some((w) => isSyncing(w.deps)) || peeks.some((p) => isSyncing(p.deps))) {
        // the deps worker reports through a state file; follow it to the end
        this.poll = setTimeout(() => void this.refresh(), 2000);
      }
    }

    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint;
      this.changed.fire(state);
    }
    this.refreshed.fire();
  }

  /** Watches git's worktree bookkeeping, so changes made elsewhere show up. */
  private async watch(view: View): Promise<void> {
    const key = `${view.cwd}\n${view.doc.root}`;
    if (key === this.watchKey) {
      return;
    }
    this.watchKey = key;
    this.disposeWatchers();

    const patterns: vscode.RelativePattern[] = [];
    try {
      const out = await execText("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], view.cwd);
      // index, HEAD and refs/worktree (snapshots) cover the main checkout;
      // worktrees/ holds the same for every other worktree, plus wt's stamps
      patterns.push(
        new vscode.RelativePattern(toUri(view.folder, out.trim()), "{index,HEAD,refs/worktree/**,worktrees/**}"),
      );
    } catch (err) {
      this.log(`not watching the git directory: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (fs.existsSync(view.doc.root)) {
      // managed worktrees and peeks appear and disappear here
      patterns.push(new vscode.RelativePattern(toUri(view.folder, view.doc.root), "*"));
    }
    if (key !== this.watchKey) {
      return; // superseded while git was running
    }
    for (const pattern of patterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const touch = () => this.schedule();
      this.watchers.push(watcher, watcher.onDidCreate(touch), watcher.onDidChange(touch), watcher.onDidDelete(touch));
    }
  }

  private disposeWatchers(): void {
    this.watchers.forEach((w) => w.dispose());
    this.watchers = [];
  }

  dispose(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    if (this.poll !== undefined) {
      clearTimeout(this.poll);
    }
    this.disposeWatchers();
    this.subscriptions.forEach((s) => s.dispose());
  }
}

/** The worktree this window has open, if it is one. */
export function currentWorktree(view: View): Worktree | undefined {
  return view.doc.worktrees.find((w) => w.current);
}

export function mainWorktree(view: View): Worktree | undefined {
  return view.doc.worktrees.find((w) => w.kind === "main");
}
