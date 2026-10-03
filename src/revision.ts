// File contents the diff editor can show without opening a real file: a file
// at a git revision, and the working copy of a file in another worktree.

import { readFile } from "node:fs/promises";
import * as vscode from "vscode";
import { execText } from "./cli";

export const revisionScheme = "wt-snap";

/**
 * A file as it was at a git revision of a worktree: a commit, a snapshot
 * (snapshots are ordinary commit objects) or HEAD. An empty ref is an empty
 * document: the missing side of an added or deleted file.
 */
export function revisionUri(worktree: string, ref: string, file: string): vscode.Uri {
  return vscode.Uri.from({ scheme: revisionScheme, path: `/${file}`, query: JSON.stringify({ worktree, ref }) });
}

export class RevisionContent implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { worktree, ref } = JSON.parse(uri.query) as { worktree: string; ref: string };
    if (ref === "") {
      return "";
    }
    try {
      return await execText("git", ["show", `${ref}:${uri.path.slice(1)}`], worktree);
    } catch {
      return ""; // the revision does not have the file: an added one
    }
  }
}

export const workingScheme = "wt-work";

/**
 * The working copy of a file that lives outside this window's folder — in
 * another worktree — as a read-only document. Opening the real file there
 * makes the git extension notice a repository above it and ask, every time,
 * whether to open it; a document under our own scheme is none of its concern.
 */
export function workingUri(file: string): vscode.Uri {
  return vscode.Uri.file(file).with({ scheme: workingScheme });
}

export class WorkingContent implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    try {
      return await readFile(uri.fsPath, "utf8");
    } catch {
      return ""; // deleted since the row was drawn
    }
  }

  /** Re-reads the documents that are open, so a diff left open keeps up with the file. */
  refresh(): void {
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme === workingScheme) {
        this.changed.fire(document.uri);
      }
    }
  }

  dispose(): void {
    this.changed.dispose();
  }
}
