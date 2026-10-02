// What every command handler shares: registration with error reporting, and
// the "is wt usable in this window" gate.

import * as vscode from "vscode";
import { WtError } from "./cli";
import { Store, View } from "./store";

export function report(log: vscode.OutputChannel, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const hint = err instanceof WtError && err.hint !== undefined ? ` (hint: ${err.hint})` : "";
  log.appendLine(`error: ${message}${hint}`);
  void vscode.window.showErrorMessage(`wt: ${message}${hint}`, "Show Log").then((choice) => {
    if (choice !== undefined) {
      log.show(true);
    }
  });
}

/** Registers a command whose failures end up as an error message, never unhandled. */
export function registerCommand(
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
  id: string,
  handler: (...args: any[]) => unknown,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      try {
        await handler(...args);
      } catch (err) {
        report(log, err);
      }
    }),
  );
}

/** The current view, or undefined after telling the user why there is none. */
export async function ready(store: Store): Promise<View | undefined> {
  if (store.view === undefined) {
    await store.refresh();
  }
  if (store.view === undefined) {
    const why: Record<string, string> = {
      nofolder: "open a folder first",
      missing: "the wt CLI was not found — set wt.path or install it from wt.glevski.com",
      outdated: "this wt is too old for the extension — update it",
      norepo: "the open folder is not inside a git repository",
    };
    const state = store.state;
    const reason = state.kind === "error" ? state.message : (why[state.kind] ?? "not ready yet");
    void vscode.window.showWarningMessage(`wt: ${reason}`);
  }
  return store.view;
}
