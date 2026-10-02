// The Worktrees view: one flat list in the CLI's order — main checkout,
// bases, then the rest by most recent use — followed by peeks.

import * as vscode from "vscode";
import {
  Kind,
  Peek,
  Worktree,
  age,
  changeSummary,
  depsFailed,
  describePeek,
  describeWorktree,
  isSyncing,
  peekContext,
  shortSha,
  worktreeContext,
} from "./model";
import { Store } from "./store";

export type Node = { type: "worktree"; worktree: Worktree } | { type: "peek"; peek: Peek; current: boolean };

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

export class WorktreeTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscription: vscode.Disposable;
  private readonly tick: NodeJS.Timeout;

  constructor(private readonly store: Store) {
    this.subscription = store.onDidChange(() => this.changed.fire());
    // rows show ages ("checkout 5m"); redraw so they keep telling the truth
    this.tick = setInterval(() => this.changed.fire(), 60_000);
  }

  getChildren(node?: Node): Node[] {
    const view = this.store.view;
    if (node !== undefined || view === undefined) {
      return [];
    }
    return [
      ...view.doc.worktrees.map((worktree): Node => ({ type: "worktree", worktree })),
      ...view.doc.peeks.map((peek): Node => ({ type: "peek", peek, current: peek.path === view.peek?.path })),
    ];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return node.type === "worktree" ? worktreeItem(node.worktree) : peekItem(node.peek, node.current);
  }

  dispose(): void {
    clearInterval(this.tick);
    this.subscription.dispose();
    this.changed.dispose();
  }
}

function label(name: string, current: boolean): vscode.TreeItemLabel {
  return { label: name, highlights: current ? [[0, name.length]] : [] };
}

function worktreeItem(w: Worktree): vscode.TreeItem {
  const look = kindLook[w.kind];
  const item = new vscode.TreeItem(label(w.name, w.current));
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
