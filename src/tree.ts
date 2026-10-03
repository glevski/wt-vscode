// The Worktrees view: one list in the CLI's order — main checkout, bases,
// then the rest by most recent use — followed by peeks. A worktree unfolds
// into what it holds that its base branch does not: its uncommitted changes,
// like the Changes group of the Source Control view, and below them the
// commits it has on top of that branch.

import * as path from "node:path";
import * as vscode from "vscode";
import { execText } from "./cli";
import { History, commitLimit } from "./history";
import {
  Commit,
  FileChange,
  Kind,
  Parent,
  Peek,
  Worktree,
  age,
  changeLook,
  changeSummary,
  countText,
  depsFailed,
  describeCommit,
  describePeek,
  describeWorktree,
  isSyncing,
  parseNameStatus,
  parseStatus,
  peekContext,
  shortSha,
  worktreeContext,
} from "./model";
import { revisionUri, workingUri } from "./revision";
import { Store, currentWorktree, toUri } from "./store";
import { ready, registerCommand } from "./ui";

/** A place a window can go; what the worktree commands receive. */
export type Node = { type: "worktree"; worktree: Worktree } | { type: "peek"; peek: Peek; current: boolean };

/** One changed file under a worktree row. */
export type ChangeNode = { type: "change"; worktree: Worktree; change: FileChange };

/** The group under a worktree row holding its commits on top of the parent branch. */
export type CommitsNode = { type: "commits"; worktree: Worktree; parent: Parent };

export type CommitNode = { type: "commit"; worktree: Worktree; commit: Commit };

export type Row = Node | ChangeNode | CommitsNode | CommitNode;

// Changed files carry their own scheme so that this extension, not the git
// one, decorates them: the git extension only knows the repository this
// window has open, and rows of other worktrees would stay bare.
const changeScheme = "wt-change";

/** The status letter and color at the right edge of a changed file's row. */
export class ChangeDecorations implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== changeScheme) {
      return undefined;
    }
    const look = changeLook(uri.query);
    return new vscode.FileDecoration(uri.query, look.title, new vscode.ThemeColor(look.color));
  }
}

// Same colors as `wt list`: cyan main, orange base, green managed, magenta
// for worktrees other tools made, red peeks. Not "folder" or "file" for an
// icon: those two ids mean "ask the file icon theme", which draws them in
// the theme's own style and indents the row like a child.
const kindLook: Record<Kind, { icon: string; color: string; title: string }> = {
  main: { icon: "home", color: "terminal.ansiCyan", title: "main checkout" },
  base: { icon: "lock", color: "charts.orange", title: "base worktree" },
  managed: { icon: "git-branch", color: "terminal.ansiGreen", title: "wt worktree" },
  external: { icon: "file-symlink-directory", color: "terminal.ansiMagenta", title: "worktree made by another tool" },
};

export class WorktreeTree implements vscode.TreeDataProvider<Row>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscriptions: vscode.Disposable[];
  private readonly tick: NodeJS.Timeout;
  /** Paths of the worktrees whose file lists are unfolded. */
  private readonly expanded = new Set<string>();
  private readonly history: History;
  /** Each worktree's parent branch, by worktree path; worked out with the rows. */
  private parents = new Map<string, Parent>();

  constructor(
    private readonly store: Store,
    log: (line: string) => void,
  ) {
    this.history = new History(log);
    let stale = false;
    this.subscriptions = [
      store.onDidChange(() => (stale = true)),
      // An unfolded file list can change while the worktree row stays the
      // same (another file, the same line counts), so while any is open the
      // tree re-reads on every refresh, not only when the list changed.
      store.onDidRefresh(() => {
        if (stale || this.expanded.size > 0) {
          stale = false;
          this.changed.fire();
        }
      }),
    ];
    // rows show ages ("checkout 5m"); redraw so they keep telling the truth
    this.tick = setInterval(() => this.changed.fire(), 60_000);
  }

  /** The view reports rows being unfolded and folded. */
  setExpanded(row: Row, expanded: boolean): void {
    if (row.type !== "worktree") {
      return;
    }
    if (expanded) {
      this.expanded.add(row.worktree.path);
    } else {
      this.expanded.delete(row.worktree.path);
    }
  }

  async getChildren(row?: Row): Promise<Row[]> {
    const view = this.store.view;
    if (view === undefined) {
      return [];
    }
    if (row === undefined) {
      this.parents = await this.history.resolve(view);
      const unfoldable = new Set(view.doc.worktrees.filter((w) => this.unfolds(w)).map((w) => w.path));
      for (const path of this.expanded) {
        if (!unfoldable.has(path)) {
          this.expanded.delete(path); // gone, or nothing left in it to unfold
        }
      }
      return [
        ...view.doc.worktrees.map((worktree): Row => ({ type: "worktree", worktree })),
        ...view.doc.peeks.map((peek): Row => ({ type: "peek", peek, current: peek.path === view.peek?.path })),
      ];
    }
    try {
      if (row.type === "worktree") {
        const worktree = row.worktree;
        const rows: Row[] = [];
        if (worktree.state === "dirty") {
          rows.push(...(await listChanges(worktree)).map((change): Row => ({ type: "change", worktree, change })));
        }
        const parent = this.parents.get(worktree.path);
        if (parent !== undefined && parent.ahead > 0) {
          rows.push({ type: "commits", worktree, parent });
        }
        return rows;
      }
      if (row.type === "commits") {
        const commits = await this.history.commits(view.cwd, row.parent, row.worktree.head);
        return commits.map((commit): Row => ({ type: "commit", worktree: row.worktree, commit }));
      }
    } catch {
      // git could not answer (the worktree vanished mid-refresh, say): show nothing
    }
    return [];
  }

  /** A worktree row has an arrow when there is something under it: changes, or commits of its own. */
  private unfolds(w: Worktree): boolean {
    return w.state === "dirty" || (this.parents.get(w.path)?.ahead ?? 0) > 0;
  }

  getTreeItem(row: Row): vscode.TreeItem {
    switch (row.type) {
      case "worktree":
        return worktreeItem(row.worktree, this.parents.get(row.worktree.path), this.unfolds(row.worktree));
      case "peek":
        return peekItem(row.peek, row.current);
      case "change":
        return changeItem(this.store.view?.folder, row.worktree, row.change);
      case "commits":
        return commitsItem(row.worktree, row.parent);
      case "commit":
        return commitItem(row);
    }
  }

  dispose(): void {
    clearInterval(this.tick);
    this.subscriptions.forEach((s) => s.dispose());
    this.changed.dispose();
  }
}

/** A worktree's uncommitted changes, as `git status` reports them. */
async function listChanges(worktree: Worktree): Promise<FileChange[]> {
  const out = await execText("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], worktree.path);
  return parseStatus(out);
}

/** The real file behind a changed-file row, as a URI this window can open. */
function changedFile(folder: vscode.Uri | undefined, w: Worktree, change: FileChange): vscode.Uri {
  const file = path.join(w.path, change.path);
  return folder !== undefined ? toUri(folder, file) : vscode.Uri.file(file);
}

/**
 * What a change compares. `file` is the working copy: the real, editable
 * file in the window's own worktree, a read-only copy for any other — there
 * a click is for looking, and the real file would have the git extension ask
 * to open that repository. `original` is the committed version, missing for
 * a new file; `modified` is `file`, missing when it was deleted.
 */
function changeSides(
  folder: vscode.Uri | undefined,
  w: Worktree,
  change: FileChange,
): { file: vscode.Uri; original: vscode.Uri | undefined; modified: vscode.Uri | undefined } {
  const file = w.current ? changedFile(folder, w, change) : workingUri(path.join(w.path, change.path));
  const isNew = change.status === "U" || change.status === "A";
  return {
    file,
    original: isNew ? undefined : revisionUri(w.path, "HEAD", change.path),
    modified: change.status === "D" ? undefined : file,
  };
}

/** The commands on the rows: one file's real file, and a worktree's changes all at once. */
export function registerChangeCommands(context: vscode.ExtensionContext, store: Store, log: vscode.OutputChannel): void {
  // the button on a changed file: the file itself, not its diff
  registerCommand(context, log, "wt.openChangedFile", async (row?: Row) => {
    if (row?.type === "change") {
      await vscode.commands.executeCommand("vscode.open", changedFile(store.view?.folder, row.worktree, row.change));
    }
  });

  // the button on a worktree with changes: every changed file in one diff
  // editor, like Open Changes on Source Control's Changes group
  registerCommand(context, log, "wt.openChanges", async (row?: Row) => {
    const view = await ready(store);
    if (view === undefined) {
      return;
    }
    const worktree = row?.type === "worktree" ? row.worktree : currentWorktree(view);
    if (worktree === undefined) {
      return;
    }
    const changes = await listChanges(worktree);
    if (changes.length === 0) {
      void vscode.window.showInformationMessage(`wt: no uncommitted changes in '${worktree.name}'.`);
      return;
    }
    const rows = changes.map((change) => {
      const sides = changeSides(view.folder, worktree, change);
      return [sides.file, sides.original, sides.modified];
    });
    await vscode.commands.executeCommand("vscode.changes", `Changes in ${worktree.name}`, rows);
  });

  // a click on a commit row: what that commit changed, every file in one diff editor
  registerCommand(context, log, "wt.openCommit", async (row?: Row) => {
    const view = store.view;
    if (row?.type !== "commit" || view === undefined) {
      return;
    }
    const { sha, subject } = row.commit;
    const before = `${sha}^`;
    const out = await execText("git", ["diff", "--name-status", "-z", "--no-renames", before, sha], view.cwd);
    const rows = parseNameStatus(out).map((change) => [
      revisionUri(view.cwd, sha, change.path),
      change.status === "A" ? undefined : revisionUri(view.cwd, before, change.path),
      change.status === "D" ? undefined : revisionUri(view.cwd, sha, change.path),
    ]);
    if (rows.length === 0) {
      void vscode.window.showInformationMessage(`wt: commit ${shortSha(sha)} changed no files.`);
      return;
    }
    await vscode.commands.executeCommand("vscode.changes", `${shortSha(sha)} ${subject}`, rows);
  });

  registerCommand(context, log, "wt.copyCommitSha", async (row?: Row) => {
    if (row?.type === "commit") {
      await vscode.env.clipboard.writeText(row.commit.sha);
    }
  });
}

function changeItem(folder: vscode.Uri | undefined, w: Worktree, change: FileChange): vscode.TreeItem {
  const sides = changeSides(folder, w, change);
  // built from the path alone, so the file icon theme picks the icon and the
  // name is the label, exactly as in Source Control
  const item = new vscode.TreeItem(
    vscode.Uri.file(path.join(w.path, change.path)).with({ scheme: changeScheme, query: change.status }),
  );
  item.id = `${w.path}\n${change.path}`;
  const dir = path.dirname(change.path);
  item.description = dir === "." ? "" : dir;
  item.contextValue = "wtChange";
  item.tooltip = `${path.join(w.path, change.path)} • ${changeLook(change.status).title}`;
  if (change.status === "U") {
    // nothing to compare an untracked file with
    item.command = { command: "vscode.open", title: "Open File", arguments: [sides.file] };
  } else {
    // the two-sided editor needs both sides: a missing one is an empty document
    const empty = revisionUri(w.path, "", change.path);
    item.command = {
      command: "vscode.diff",
      title: "Open Changes",
      arguments: [sides.original ?? empty, sides.modified ?? empty, `${path.basename(change.path)} (${w.name})`],
    };
  }
  return item;
}

function commitsItem(w: Worktree, parent: Parent): vscode.TreeItem {
  // unfolded from the start: opening the worktree row is the one click
  const item = new vscode.TreeItem(`On top of ${parent.branch}`, vscode.TreeItemCollapsibleState.Expanded);
  item.id = `${w.path}\ncommits`;
  item.description =
    parent.ahead > commitLimit
      ? `${countText(parent.ahead, "commit")}, newest ${commitLimit} shown`
      : countText(parent.ahead, "commit");
  item.iconPath = new vscode.ThemeIcon("git-compare");
  item.contextValue = "wtCommits";
  item.tooltip = parent.recorded
    ? `Commits in '${w.name}' that ${parent.branch}, the branch it was created from, does not have`
    : `Commits in '${w.name}' that ${parent.branch} does not have. wt has no base branch on record for this worktree, so this is the nearest one.`;
  return item;
}

function commitItem(row: CommitNode): vscode.TreeItem {
  const { worktree: w, commit } = row;
  const item = new vscode.TreeItem(commit.subject);
  item.id = `${w.path}\n${commit.sha}`;
  item.description = describeCommit(commit);
  item.iconPath = new vscode.ThemeIcon("git-commit");
  item.contextValue = "wtCommit";
  const tip = new vscode.MarkdownString();
  tip.appendText(commit.subject);
  tip.appendMarkdown("\n\n");
  tip.appendText(`${commit.author}, ${new Date(commit.date).toLocaleString()}`);
  tip.appendMarkdown(`\n\n\`${commit.sha}\``);
  item.tooltip = tip;
  item.command = { command: "wt.openCommit", title: "Open Changes", arguments: [row] };
  return item;
}

function label(name: string, current: boolean): vscode.TreeItemLabel {
  return { label: name, highlights: current ? [[0, name.length]] : [] };
}

function worktreeItem(w: Worktree, parent: Parent | undefined, unfolds: boolean): vscode.TreeItem {
  const look = kindLook[w.kind];
  const item = new vscode.TreeItem(
    label(w.name, w.current),
    unfolds ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
  );
  item.id = w.path;
  item.description = describeWorktree(w);
  item.contextValue = worktreeContext(w);
  item.iconPath = isSyncing(w.deps)
    ? new vscode.ThemeIcon("sync~spin")
    : new vscode.ThemeIcon(look.icon, new vscode.ThemeColor(look.color));

  const tip = new vscode.MarkdownString();
  tip.appendMarkdown(`**${escape(w.name)}** — ${look.title}${w.current ? ", open in this window" : ""}\n\n`);
  row(tip, "Branch", w.detached ? "(detached)" : w.branch);
  row(tip, "Commit", shortSha(w.head));
  row(tip, "Created from", w.base);
  if (parent !== undefined) {
    row(tip, `On top of ${parent.branch}`, parent.ahead > 0 ? countText(parent.ahead, "commit") : "no commits of its own");
  }
  if (w.kind === "base") {
    row(tip, "Pinned to", w.drifted ? `${w.pinned} (drifted)` : w.pinned);
  }
  const uncommitted =
    w.state === "dirty" && w.files !== undefined
      ? ` — ${changeSummary({ files: w.files, insertions: w.insertions ?? 0, deletions: w.deletions ?? 0 })} uncommitted`
      : "";
  row(tip, "State", `${w.state}${uncommitted}`);
  row(tip, "Deps", depsText(w.deps));
  row(tip, "Created", ago(w.created));
  row(tip, "Last checkout", ago(w.checkout));
  row(tip, "Last commit", ago(w.committed));
  row(tip, "Path", w.path);
  item.tooltip = tip;
  return item;
}

function peekItem(p: Peek, current: boolean): vscode.TreeItem {
  const item = new vscode.TreeItem(label(p.name, current));
  item.id = p.path;
  item.description = describePeek(p);
  item.contextValue = peekContext(current);
  item.iconPath = isSyncing(p.deps)
    ? new vscode.ThemeIcon("sync~spin")
    : new vscode.ThemeIcon("eye", new vscode.ThemeColor("terminal.ansiRed"));

  const tip = new vscode.MarkdownString();
  tip.appendMarkdown(`**${escape(p.name)}** — read-only peek${current ? ", open in this window" : ""}\n\n`);
  row(tip, "Revision", p.rev);
  row(tip, "Commit", shortSha(p.sha));
  row(tip, "Taken from", p.source);
  row(tip, "Deps", depsText(p.deps));
  row(tip, "Created", ago(p.created));
  row(tip, "Path", p.path);
  item.tooltip = tip;
  return item;
}

function depsText(deps: string | undefined): string | undefined {
  if (deps === undefined) {
    return undefined;
  }
  if (isSyncing(deps)) {
    return "syncing in the background";
  }
  return depsFailed(deps) ? deps : deps === "done" ? "copied" : deps;
}

function ago(iso: string | undefined): string | undefined {
  const text = age(iso);
  return text === undefined || text === "now" ? text : `${text} ago`;
}

function row(tip: vscode.MarkdownString, name: string, value: string | undefined): void {
  if (value === undefined || value === "") {
    return;
  }
  tip.appendMarkdown(`${name}: `);
  tip.appendText(value);
  tip.appendMarkdown("  \n");
}

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&");
}
