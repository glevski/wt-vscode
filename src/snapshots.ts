// The Snapshots view: the private, diffable records `wt snap` keeps for the
// worktree this window has open. The current commit's series is listed
// directly, newest first; series on earlier commits fold under their commit.
// A snapshot unfolds into the files it changed, each opening as a diff.

import * as path from "node:path";
import * as vscode from "vscode";
import { Cli, WtError, execText } from "./cli";
import {
  FileChange,
  Series,
  Snapshot,
  SnapshotDoc,
  describeSnapshot,
  parseNameStatus,
  shortSha,
  statusWord,
} from "./model";
import { revisionUri } from "./revision";
import { Store, currentWorktree, toUri } from "./store";
import { ready, registerCommand } from "./ui";

export type SnapshotState =
  | { kind: "hidden" | "peek" | "outdated" }
  | { kind: "error"; message: string }
  | { kind: "ready"; doc: SnapshotDoc; folder: vscode.Uri };

/** Loads `wt snap ls --all --json` alongside the worktree list, while someone is looking. */
export class SnapshotStore implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<SnapshotState>();
  readonly onDidChange = this.changed.event;

  private current: SnapshotState = { kind: "hidden" };
  private fingerprint = "";
  private generation = 0;
  private visible = false;
  private stale = true;
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly store: Store,
    private readonly cli: Cli,
    private readonly log: (line: string) => void,
  ) {
    this.subscription = store.onDidRefresh(() => void this.refresh());
  }

  get state(): SnapshotState {
    return this.current;
  }

  /** The view reports whether it is on screen; a hidden view costs nothing. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible && this.stale) {
      void this.refresh();
    }
  }

  async refresh(force = false): Promise<void> {
    if (!this.visible && !force) {
      this.stale = true;
      return;
    }
    this.stale = false;
    const generation = ++this.generation;
    const state = await this.load();
    if (generation !== this.generation) {
      return; // a newer refresh is on its way
    }
    this.current = state;
    const kind = state.kind === "ready" ? (state.doc.series.length > 0 ? "list" : "empty") : state.kind;
    void vscode.commands.executeCommand("setContext", "wt.snapshots", kind);
    const fingerprint = JSON.stringify(state.kind === "ready" ? state.doc : state);
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint;
      this.changed.fire(state);
    }
  }

  private async load(): Promise<SnapshotState> {
    const view = this.store.view;
    if (view === undefined) {
      return { kind: "hidden" };
    }
    if (view.peek !== undefined) {
      return { kind: "peek" };
    }
    try {
      return { kind: "ready", doc: await this.cli.snapshots(view.folder.fsPath), folder: view.folder };
    } catch (err) {
      if (err instanceof WtError && err.kind === "outdated") {
        return { kind: "outdated" };
      }
      const message = err instanceof Error ? err.message : String(err);
      this.log(`snapshots failed: ${message}`);
      return { kind: "error", message };
    }
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}

// ---- the tree ----

export type SnapNode =
  | { type: "series"; series: Series }
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "file"; snapshot: Snapshot; change: FileChange };

export class SnapshotTree implements vscode.TreeDataProvider<SnapNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscription: vscode.Disposable;
  /** Snapshots never change, so neither does what one touched. */
  private readonly fileCache = new Map<string, FileChange[]>();

  constructor(private readonly snapshots: SnapshotStore) {
    this.subscription = snapshots.onDidChange(() => this.changed.fire());
  }

  async getChildren(node?: SnapNode): Promise<SnapNode[]> {
    const state = this.snapshots.state;
    if (state.kind !== "ready") {
      return [];
    }
    if (node === undefined) {
      const current = state.doc.series.find((s) => s.current);
      return [
        ...(current?.snapshots ?? []).map((snapshot): SnapNode => ({ type: "snapshot", snapshot })),
        ...state.doc.series.filter((s) => !s.current).map((series): SnapNode => ({ type: "series", series })),
      ];
    }
    if (node.type === "series") {
      return node.series.snapshots.map((snapshot): SnapNode => ({ type: "snapshot", snapshot }));
    }
    if (node.type === "snapshot") {
      const changes = await this.files(state.doc.worktree, node.snapshot);
      return changes.map((change): SnapNode => ({ type: "file", snapshot: node.snapshot, change }));
    }
    return [];
  }

  /** The files a snapshot changed relative to the one before it. */
  async files(worktree: string, snapshot: Snapshot): Promise<FileChange[]> {
    let changes = this.fileCache.get(snapshot.sha);
    if (changes === undefined) {
      const out = await execText(
        "git",
        ["diff", "--name-status", "-z", "--no-renames", snapshot.parent, snapshot.sha],
        worktree,
      );
      changes = parseNameStatus(out);
      this.fileCache.set(snapshot.sha, changes);
    }
    return changes;
  }

  getTreeItem(node: SnapNode): vscode.TreeItem {
    const state = this.snapshots.state;
    if (node.type === "series") {
      const count = node.series.snapshots.length;
      const item = new vscode.TreeItem(
        `on ${shortSha(node.series.base)} ${node.series.subject}`,
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.id = `series:${node.series.base}`;
      item.description = `${count} snapshot${count === 1 ? "" : "s"}`;
      item.iconPath = new vscode.ThemeIcon("git-commit");
      item.contextValue = "wt.snapSeries";
      item.tooltip = "Snapshots recorded on an earlier commit";
      return item;
    }
    if (node.type === "snapshot") {
      const s = node.snapshot;
      const item = new vscode.TreeItem(s.message, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = s.sha;
      item.description = describeSnapshot(s);
      item.iconPath = new vscode.ThemeIcon("device-camera");
      item.contextValue = "wt.snapshot";
      const tip = new vscode.MarkdownString();
      tip.appendMarkdown(`**snapshot ${s.n}**\n\n`);
      tip.appendText(s.message);
      tip.appendMarkdown(`\n\n${new Date(s.created).toLocaleString()} · \`${shortSha(s.sha)}\``);
      item.tooltip = tip;
      return item;
    }
    const { snapshot, change } = node;
    const worktree = state.kind === "ready" ? state.doc.worktree : "";
    const folder = state.kind === "ready" ? state.folder : vscode.Uri.file(worktree);
    const item = new vscode.TreeItem(toUri(folder, path.join(worktree, change.path)));
    item.id = `${snapshot.sha}:${change.path}`;
    const dir = path.dirname(change.path);
    item.description = [dir === "." ? "" : dir, statusWord(change.status)].filter((part) => part !== "").join(" · ");
    item.contextValue = "wt.snapFile";
    item.command = {
      command: "vscode.diff",
      title: "Open Changes",
      arguments: [
        revisionUri(worktree, change.status === "A" ? "" : snapshot.parent, change.path),
        revisionUri(worktree, change.status === "D" ? "" : snapshot.sha, change.path),
        `${path.basename(change.path)} — snapshot ${snapshot.n}`,
      ],
    };
    return item;
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}

// ---- wiring ----

/** One row of the multi-file diff editor: label, original, modified. */
type ChangeRow = [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined];

export function registerSnapshots(
  context: vscode.ExtensionContext,
  store: Store,
  cli: Cli,
  log: vscode.OutputChannel,
): void {
  const snapshots = new SnapshotStore(store, cli, (line) => log.appendLine(line));
  const tree = new SnapshotTree(snapshots);
  const view = vscode.window.createTreeView("wt.snapshots", { treeDataProvider: tree });
  snapshots.setVisible(view.visible);

  context.subscriptions.push(
    snapshots,
    tree,
    view,
    view.onDidChangeVisibility((event) => snapshots.setVisible(event.visible)),
    // snapshots belong to one worktree; the header says which one is listed
    store.onDidChange(() => {
      const here = store.view && currentWorktree(store.view);
      view.title = here !== undefined ? `Snapshots (${here.name})` : "Snapshots";
    }),
    snapshots.onDidChange((state) => {
      const onlyEarlier = state.kind === "ready" && state.doc.series.length > 0 && !state.doc.series.some((s) => s.current);
      view.message = onlyEarlier ? "No snapshots on the current commit yet." : undefined;
    }),
  );

  const register = (id: string, handler: (...args: any[]) => unknown) => registerCommand(context, log, id, handler);

  /** The window's worktree folder, or undefined after saying why snapshots are not available. */
  async function worktreeFolder(): Promise<vscode.Uri | undefined> {
    const current = await ready(store);
    if (current === undefined) {
      return undefined;
    }
    if (current.peek !== undefined) {
      void vscode.window.showInformationMessage("wt: snapshots need a real worktree — this window is a read-only peek.");
      return undefined;
    }
    return current.folder;
  }

  register("wt.snapshot", async () => {
    const folder = await worktreeFolder();
    if (folder === undefined) {
      return;
    }
    const message = await vscode.window.showInputBox({
      title: "Record a snapshot",
      prompt: "Saves your tracked and untracked changes privately: no commit, nothing on the branch, nothing pushed.",
      placeHolder: "message (optional)",
    });
    if (message === undefined) {
      return;
    }
    const text = message.trim();
    // -m, so a message like "diff the parser" is not read as a subcommand
    const { notes } = await cli.runWithNotes(["snapshot", ...(text !== "" ? ["-m", text] : [])], folder.fsPath);
    await snapshots.refresh(true);
    void vscode.window.showInformationMessage(`wt: ${notes[notes.length - 1] ?? "snapshot recorded"}`);
  });

  register("wt.snapshotChanges", async () => {
    const folder = await worktreeFolder();
    if (folder === undefined) {
      return;
    }
    const doc = await cli.snapshots(folder.fsPath);
    const latest = doc.series.find((s) => s.current)?.snapshots[0];
    // what `wt snap diff` compares with: the latest snapshot, or the commit when there is none
    const ref = latest?.sha ?? doc.head;
    const since = latest !== undefined ? `snapshot ${latest.n}` : "the last commit";
    const changes = parseNameStatus(await cli.run(["snap", "diff", "--name-status", "-z", "--no-renames"], folder.fsPath));
    if (changes.length === 0) {
      void vscode.window.showInformationMessage(`wt: nothing changed since ${since}.`);
      return;
    }
    const rows = changes.map((change): ChangeRow => {
      const file = toUri(folder, path.join(doc.worktree, change.path));
      return [
        file,
        change.status === "A" ? undefined : revisionUri(doc.worktree, ref, change.path),
        change.status === "D" ? undefined : file,
      ];
    });
    await vscode.commands.executeCommand("vscode.changes", `Changes since ${since}`, rows);
  });

  register("wt.snapshotOpenChanges", async (node?: SnapNode) => {
    const state = snapshots.state;
    if (node?.type !== "snapshot" || state.kind !== "ready") {
      return;
    }
    const { snapshot } = node;
    const worktree = state.doc.worktree;
    const changes = await tree.files(worktree, snapshot);
    if (changes.length === 0) {
      void vscode.window.showInformationMessage(`wt: snapshot ${snapshot.n} changed no files.`);
      return;
    }
    const rows = changes.map(
      (change): ChangeRow => [
        toUri(state.folder, path.join(worktree, change.path)),
        change.status === "A" ? undefined : revisionUri(worktree, snapshot.parent, change.path),
        change.status === "D" ? undefined : revisionUri(worktree, snapshot.sha, change.path),
      ],
    );
    await vscode.commands.executeCommand("vscode.changes", `snapshot ${snapshot.n}: ${snapshot.message}`, rows);
  });

  register("wt.snapshotCopySha", async (node?: SnapNode) => {
    if (node?.type === "snapshot") {
      await vscode.env.clipboard.writeText(node.snapshot.sha);
    }
  });
}
