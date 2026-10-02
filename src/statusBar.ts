// "<project> · <worktree>" in the status bar; a click opens the switcher.

import * as vscode from "vscode";
import { statusText } from "./model";
import { Store, currentWorktree } from "./store";

export function createStatusBar(store: Store): vscode.Disposable {
  const item = vscode.window.createStatusBarItem("wt.current", vscode.StatusBarAlignment.Left, 0);
  item.name = "wt worktree";
  item.command = "wt.switch";

  const update = () => {
    const view = store.view;
    const here = view && (view.peek ?? currentWorktree(view));
    if (view === undefined || here === undefined) {
      item.hide();
      return;
    }
    const showProject = vscode.workspace.getConfiguration("wt").get<boolean>("statusBar.showProject") ?? true;
    item.text = statusText(view.doc.project, here.name, view.peek !== undefined, showProject);
    item.tooltip = `wt: switch worktree (${view.doc.worktrees.length} in ${view.doc.project})`;
    item.show();
  };
  update();
  return vscode.Disposable.from(
    item,
    store.onDidChange(update),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("wt.statusBar")) {
        update();
      }
    }),
  );
}
