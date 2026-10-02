import * as os from "node:os";
import * as vscode from "vscode";
import { Cli, findBinary } from "./cli";
import { registerCommands } from "./commands";
import { registerSnapshots } from "./snapshots";
import { createStatusBar } from "./statusBar";
import { Store } from "./store";
import { WorktreeTree } from "./tree";

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
  const tree = new WorktreeTree(store);
  const view = vscode.window.createTreeView("wt.worktrees", { treeDataProvider: tree });

  context.subscriptions.push(
    log,
    store,
    tree,
    view,
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
  void store.refresh();
}

export function deactivate(): void {}
