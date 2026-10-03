import * as os from "node:os";
import * as vscode from "vscode";
import { Cli, findBinary } from "./cli";
import { registerCommands } from "./commands";
import { RevisionContent, WorkingContent, revisionScheme, workingScheme } from "./revision";
import { registerSnapshots } from "./snapshots";
import { createStatusBar } from "./statusBar";
import { Store } from "./store";
import { ChangeDecorations, WorktreeTree, registerChangeCommands } from "./tree";

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("wt");

  // Remembered once found; looked up again when the setting changes, and
  // every time while it is missing — it may get installed any moment.
  let binary: string | undefined;
  const cli = new Cli({
    binary: async () => {
      binary ??= await findBinary(vscode.workspace.getConfiguration("wt").get<string>("path") ?? "", process.env, os.homedir());
      return binary;
    },
    log: (line) => log.appendLine(line),
  });

  const store = new Store(cli, (line) => log.appendLine(line));
  const tree = new WorktreeTree(store, (line) => log.appendLine(line));
  const view = vscode.window.createTreeView("wt.worktrees", { treeDataProvider: tree });
  const working = new WorkingContent();

  context.subscriptions.push(
    log,
    store,
    tree,
    view,
    view.onDidExpandElement((event) => tree.setExpanded(event.element, true)),
    view.onDidCollapseElement((event) => tree.setExpanded(event.element, false)),
    vscode.window.registerFileDecorationProvider(new ChangeDecorations()),
    vscode.workspace.registerTextDocumentContentProvider(revisionScheme, new RevisionContent()),
    working,
    vscode.workspace.registerTextDocumentContentProvider(workingScheme, working),
    store.onDidRefresh(() => working.refresh()),
    createStatusBar(store),
    store.onDidChange((state) => {
      view.description = state.kind === "ready" ? state.view.doc.project : undefined;
      if (state.kind === "missing") {
        binary = undefined; // the remembered path stopped working
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("wt")) {
        binary = undefined;
        store.schedule(0);
      }
    }),
  );

  registerCommands(context, store, cli, log);
  registerSnapshots(context, store, cli, log);
  registerChangeCommands(context, store, log);
  void store.refresh();
}

export function deactivate(): void {}
