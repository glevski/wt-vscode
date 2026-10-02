// Command handlers. Each one asks the questions an editor can ask (pickers,
// confirmations), then hands the actual work to the wt CLI.

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { Cli, WtError, execText } from "./cli";
import { Peek, Worktree, branchChoices, describePeek, describeWorktree, isRemovable } from "./model";
import { Store, View, currentWorktree, mainWorktree, toUri } from "./store";
import { Node } from "./tree";
import { registerCommand, report, ready as whenReady } from "./ui";

/** Somewhere a window can go: a worktree or a peek. */
interface Target {
  name: string;
  path: string;
  /** Peeks are unknown to `wt checkout`; they are opened by path alone. */
  peek: boolean;
}

/** destination path → the folder the window was in before it went there. */
type PrevMap = Record<string, string>;
const prevKey = "wt.prev";

export function registerCommands(
  context: vscode.ExtensionContext,
  store: Store,
  cli: Cli,
  log: vscode.OutputChannel,
): void {
  const register = (id: string, handler: (...args: any[]) => unknown) => registerCommand(context, log, id, handler);
  const ready = () => whenReady(store);

  function openInNewWindow(): boolean {
    return vscode.workspace.getConfiguration("wt").get<string>("openIn") === "newWindow";
  }

  async function openFolder(view: View, fsPath: string, newWindow: boolean): Promise<void> {
    if (!newWindow) {
      // this window is about to reload somewhere else; remember where it
      // was, so Finish can come back — what WT_PREV is to a shell
      const prev = context.globalState.get<PrevMap>(prevKey, {});
      await context.globalState.update(prevKey, { ...prev, [fsPath]: view.folder.fsPath });
    }
    await vscode.commands.executeCommand("vscode.openFolder", toUri(view.folder, fsPath), {
      forceNewWindow: newWindow,
      forceReuseWindow: !newWindow,
    });
  }

  async function forget(fsPath: string): Promise<void> {
    const prev = { ...context.globalState.get<PrevMap>(prevKey, {}) };
    for (const [dest, from] of Object.entries(prev)) {
      if (dest === fsPath || from === fsPath) {
        delete prev[dest];
      }
    }
    await context.globalState.update(prevKey, prev);
  }

  async function open(view: View, target: Target, newWindow: boolean): Promise<void> {
    if (!target.peek) {
      // the checkout is for its side effect: the stamp behind the CHECKOUT
      // column and the recency order. The folder to open is already known.
      try {
        await cli.run(["checkout", target.name], view.cwd);
      } catch (err) {
        log.appendLine(`checkout ${target.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await openFolder(view, target.path, newWindow);
  }

  function targetOf(node: Node): Target {
    return node.type === "worktree"
      ? { name: node.worktree.name, path: node.worktree.path, peek: false }
      : { name: node.peek.name, path: node.peek.path, peek: true };
  }

  /** Quick pick over the places this window is not already in. */
  function pickTarget(view: View, placeholder: string): Promise<{ target: Target; newWindow: boolean } | undefined> {
    type Item = vscode.QuickPickItem & { target: Target };
    const newWindowButton: vscode.QuickInputButton = {
      iconPath: new vscode.ThemeIcon("empty-window"),
      tooltip: "Open in New Window",
    };
    const items: Item[] = [
      ...view.doc.worktrees
        .filter((w) => !w.current)
        .map((w): Item => ({
          label: w.name,
          description: describeWorktree(w),
          buttons: [newWindowButton],
          target: { name: w.name, path: w.path, peek: false },
        })),
      ...view.doc.peeks
        .filter((p) => p.path !== view.peek?.path)
        .map((p): Item => ({
          label: p.name,
          description: describePeek(p),
          buttons: [newWindowButton],
          target: { name: p.name, path: p.path, peek: true },
        })),
    ];
    return new Promise((resolve) => {
      const picker = vscode.window.createQuickPick<Item>();
      picker.items = items;
      picker.placeholder = items.length > 0 ? placeholder : "No other worktrees yet — wt: New Worktree creates one";
      picker.matchOnDescription = true;
      let settled = false;
      const settle = (value: { target: Target; newWindow: boolean } | undefined) => {
        if (!settled) {
          settled = true;
          resolve(value);
          picker.hide();
        }
      };
      picker.onDidAccept(() => {
        const [item] = picker.selectedItems;
        settle(item === undefined ? undefined : { target: item.target, newWindow: openInNewWindow() });
      });
      picker.onDidTriggerItemButton((event) => settle({ target: event.item.target, newWindow: true }));
      picker.onDidHide(() => {
        settle(undefined);
        picker.dispose();
      });
      picker.show();
    });
  }

  /** create and fork need a project name; offer to set one instead of failing. */
  async function ensureLinked(view: View): Promise<boolean> {
    if (view.doc.linked) {
      return true;
    }
    return link(view, "New worktrees need a project name first");
  }

  async function link(view: View, title: string): Promise<boolean> {
    const name = await vscode.window.showInputBox({
      title,
      prompt: `Worktrees are created under ${path.join(path.dirname(view.doc.root), "<name>")}`,
      value: view.doc.project,
      validateInput: (value) => (value.trim() === "" ? "A name is required" : undefined),
    });
    if (name === undefined) {
      return false;
    }
    await cli.run(["link", name.trim()], view.cwd);
    await store.refresh();
    return true;
  }

  function progress<T>(title: string, task: () => Promise<T>): Thenable<T> {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);
  }

  function insidePeek(view: View, what: string): boolean {
    if (view.peek === undefined) {
      return false;
    }
    void vscode.window.showInformationMessage(`wt: ${what} — this window is a read-only peek. Switch to a worktree first.`);
    return true;
  }

  // ---- commands ----

  register("wt.refresh", () => store.refresh());

  register("wt.showLog", () => log.show());

  register("wt.openSettings", () => vscode.commands.executeCommand("workbench.action.openSettings", "wt."));

  register("wt.switch", async () => {
    const view = await ready();
    if (view === undefined) {
      return;
    }
    const picked = await pickTarget(view, "Switch to worktree…");
    if (picked !== undefined) {
      await open(view, picked.target, picked.newWindow);
    }
  });

  register("wt.open", async (node?: Node) => {
    const view = await ready();
    if (view === undefined) {
      return;
    }
    if (node === undefined) {
      await vscode.commands.executeCommand("wt.switch");
      return;
    }
    await open(view, targetOf(node), false);
  });

  register("wt.openInNewWindow", async (node?: Node) => {
    const view = await ready();
    if (view === undefined) {
      return;
    }
    const target = node !== undefined ? targetOf(node) : (await pickTarget(view, "Open in a new window…"))?.target;
    if (target !== undefined) {
      await open(view, target, true);
    }
  });

  register("wt.home", async () => {
    const view = await ready();
    const main = view && mainWorktree(view);
    if (view === undefined || main === undefined) {
      return;
    }
    if (main.current) {
      void vscode.window.showInformationMessage("wt: this window is already the main checkout.");
      return;
    }
    await open(view, { name: main.name, path: main.path, peek: false }, false);
  });

  register("wt.link", async () => {
    const view = await ready();
    if (view !== undefined && (await link(view, "Link this repository to a project name"))) {
      void vscode.window.showInformationMessage(`wt: linked as '${store.view?.doc.project}'.`);
    }
  });

  register("wt.create", async () => {
    const view = await ready();
    if (view === undefined || insidePeek(view, "new worktrees start from a worktree") || !(await ensureLinked(view))) {
      return;
    }
    type Item = vscode.QuickPickItem & { branch?: string };
    const here = currentWorktree(view);
    const refs = await execText("git", ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"], view.cwd).catch(
      () => "",
    );
    const checkedOut = new Map(view.doc.worktrees.filter((w) => w.branch !== "").map((w) => [w.branch, w.name]));
    const items: Item[] = [
      {
        label: "$(add) New branch from the current HEAD",
        description: here?.branch ? `${here.branch}-N, without your local changes` : undefined,
      },
      { label: "existing branches", kind: vscode.QuickPickItemKind.Separator },
      ...branchChoices(refs).map((choice): Item => {
        const holder = checkedOut.get(choice.branch);
        return {
          label: `$(git-branch) ${choice.label}`,
          description: choice.remote
            ? "remote — creates the tracking branch"
            : holder !== undefined
              ? `checked out in ${holder} — creates ${choice.branch}-N off it`
              : undefined,
          branch: choice.branch,
        };
      }),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: "New worktree",
      placeHolder: "Which branch should the new worktree hold?",
      matchOnDescription: true,
    });
    if (picked === undefined) {
      return;
    }
    const args = ["create", "-c", ...(picked.branch !== undefined ? [picked.branch] : [])];
    const jump = await progress("wt: creating worktree…", () => cli.jump(args, view.cwd));
    await store.refresh();
    await openFolder(view, jump.cd, openInNewWindow());
  });

  register("wt.fork", async () => {
    const view = await ready();
    if (view === undefined || insidePeek(view, "there is nothing to fork") || !(await ensureLinked(view))) {
      return;
    }
    const branch = await vscode.window.showInputBox({
      title: "Fork current changes into a new worktree",
      prompt:
        "New branch name. Staged, unstaged and untracked changes come along; this worktree stays as it is. " +
        "Leave empty for an auto-named branch.",
      placeHolder: "branch name (optional)",
      validateInput: (value) =>
        /\s/.test(value) ? "Branch names cannot contain spaces" : value.startsWith("-") ? "Branch names cannot start with a dash" : undefined,
    });
    if (branch === undefined) {
      return;
    }
    const args = ["fork", "-c", ...(branch !== "" ? [branch] : [])];
    try {
      const jump = await progress("wt: forking into a new worktree…", () => cli.jump(args, view.cwd));
      await openFolder(view, jump.cd, openInNewWindow());
    } finally {
      // a fork can fail half way, with the worktree already created
      void store.refresh();
    }
  });

  register("wt.remove", async (node?: Node) => {
    const view = await ready();
    if (view === undefined) {
      return;
    }
    let target: Worktree | undefined;
    if (node?.type === "worktree") {
      target = node.worktree;
    } else {
      const candidates = view.doc.worktrees.filter((w) => isRemovable(w) && !w.current);
      if (candidates.length === 0) {
        void vscode.window.showInformationMessage("wt: there is no other worktree to remove.");
        return;
      }
      const picked = await vscode.window.showQuickPick(
        candidates.map((w) => ({ label: w.name, description: describeWorktree(w), detail: w.path, worktree: w })),
        { title: "Remove worktree", placeHolder: "Which worktree should be removed?" },
      );
      target = picked?.worktree;
    }
    if (target === undefined) {
      return;
    }
    if (target.current) {
      await vscode.commands.executeCommand("wt.finish");
      return;
    }

    const withBranch = "Remove and Delete Branch";
    const choice = await vscode.window.showWarningMessage(
      `Remove worktree '${target.name}'?`,
      { modal: true, detail: removalDetail(target) },
      "Remove",
      ...(target.branch !== "" ? [withBranch] : []),
    );
    if (choice === undefined) {
      return;
    }
    const flags = choice === withBranch ? ["-b"] : [];
    try {
      await removeWithForce(target, (force) => cli.run(["remove", ...force, ...flags, target.name], view.cwd));
      await forget(target.path);
    } finally {
      await store.refresh();
    }
  });

  register("wt.finish", async () => {
    const view = await ready();
    if (view === undefined) {
      return;
    }
    if (view.peek !== undefined) {
      void vscode.window.showInformationMessage(
        "wt: a peek is not finished, it is discarded — run `wt unpeek` in the terminal, or switch to a worktree.",
      );
      return;
    }
    const here = currentWorktree(view);
    const main = mainWorktree(view);
    if (here === undefined || main === undefined || here.kind === "main") {
      void vscode.window.showInformationMessage("wt: the main checkout is never finished — Finish is for worktrees.");
      return;
    }

    const prev = context.globalState.get<PrevMap>(prevKey, {})[here.path];
    const cameFrom = prev !== undefined && prev !== here.path && fs.existsSync(prev) ? prev : undefined;
    const back = path.basename(cameFrom ?? main.path);

    type Item = vscode.QuickPickItem & { flags: string[] };
    const items: Item[] = [{ label: "$(arrow-left) Go back", detail: `Keep '${here.name}' and return to ${back}`, flags: [] }];
    if (here.kind !== "base") {
      items.push({
        label: "$(trash) Go back and remove this worktree",
        detail: here.branch !== "" ? `The branch '${here.branch}' is kept` : undefined,
        flags: ["-d"],
      });
      if (here.branch !== "") {
        items.push({
          label: "$(trash) Go back, remove this worktree and delete its branch",
          detail: `Deletes '${here.branch}' if it is merged`,
          flags: ["-d", "-b"],
        });
      }
    }
    const picked = await vscode.window.showQuickPick(items, { title: `Finish '${here.name}'` });
    if (picked === undefined) {
      return;
    }
    const removing = picked.flags.includes("-d");
    if (removing) {
      const ok = await vscode.window.showWarningMessage(
        `Remove worktree '${here.name}'?`,
        { modal: true, detail: removalDetail(here) },
        "Remove",
      );
      if (ok === undefined) {
        return;
      }
    }

    const env: Record<string, string> = cameFrom !== undefined ? { WT_PREV: cameFrom } : {};
    try {
      const jump = removing
        ? await removeWithForce(here, (force) => cli.jump(["finish", ...picked.flags, ...force], view.cwd, env))
        : await cli.jump(["finish"], view.cwd, env);
      if (jump === undefined) {
        return;
      }
      if (removing) {
        await forget(here.path);
      }
      await openFolder(view, jump.cd, false);
    } catch (err) {
      // the worktree can be gone even though finish failed (branch not
      // merged, say); a window must not stay in a deleted folder
      if (removing && !fs.existsSync(here.path)) {
        report(log, err);
        await forget(here.path);
        await openFolder(view, main.path, false);
        return;
      }
      throw err;
    }
  });

  register("wt.copyPath", async (node?: Node) => {
    if (node !== undefined) {
      await vscode.env.clipboard.writeText(targetOf(node).path);
    }
  });

  register("wt.openTerminal", (node?: Node) => {
    if (node !== undefined) {
      const target = targetOf(node);
      vscode.window.createTerminal({ name: `wt: ${target.name}`, cwd: target.path }).show();
    }
  });

  /**
   * Runs a removal; when wt refuses because of local changes (its hint names
   * the force flag), asks once more and retries with -f. Resolves undefined
   * when the user backs out.
   */
  async function removeWithForce<T>(target: Worktree | Peek, attempt: (force: string[]) => Promise<T>): Promise<T | undefined> {
    try {
      return await attempt([]);
    } catch (err) {
      if (!(err instanceof WtError) || !err.forceable) {
        throw err;
      }
      const ok = await vscode.window.showWarningMessage(
        `'${target.name}' has work that would be lost`,
        // git's own sentence is the useful part of "git worktree remove …: fatal: …"
        { modal: true, detail: `${err.message.replace(/^.*fatal: /, "")}\n\nDiscard it and remove the worktree anyway?` },
        "Discard and Remove",
      );
      if (ok === undefined) {
        return undefined;
      }
      return attempt(["-f"]);
    }
  }
}

function removalDetail(w: Worktree): string {
  const lines = [w.path];
  if (w.branch !== "") {
    lines.push(`Branch: ${w.branch}`);
  }
  if (w.state === "dirty") {
    lines.push("It has uncommitted changes.");
  }
  return lines.join("\n");
}
