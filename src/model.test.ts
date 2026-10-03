import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Snapshot,
  Worktree,
  age,
  baseBranches,
  branchChoices,
  branchInName,
  changeLook,
  changeSummary,
  countText,
  describeCommit,
  describeSnapshot,
  describeWorktree,
  hasParent,
  isRemovable,
  isSyncing,
  lineSummary,
  parseCommits,
  parseJump,
  parseList,
  parseNameStatus,
  parseSnapshots,
  parseStatus,
  peekContext,
  pickParent,
  statusText,
  statusWord,
  worktreeContext,
} from "./model";

function worktree(over: Partial<Worktree> = {}): Worktree {
  return {
    name: "feature-auth",
    path: "/home/u/worktrees/proj/feature-auth",
    branch: "feature/auth",
    head: "163a116f00000000000000000000000000000000",
    detached: false,
    kind: "managed",
    current: false,
    state: "clean",
    drifted: false,
    ...over,
  };
}

test("parseList reads the document and tolerates a missing peeks array", () => {
  const doc = parseList(JSON.stringify({ schema: 1, project: "proj", linked: true, root: "/r", worktrees: [worktree()] }));
  assert.equal(doc.project, "proj");
  assert.equal(doc.worktrees[0].name, "feature-auth");
  assert.deepEqual(doc.peeks, []);
});

test("parseList rejects anything that is not the list document", () => {
  assert.throws(() => parseList("  NAME  BRANCH  STATE\n* wt  main  clean\n"));
  assert.throws(() => parseList(JSON.stringify({ worktrees: [] })));
  assert.throws(() => parseList("null"));
});

test("parseJump reads one JSON line and rejects the shell script", () => {
  assert.deepEqual(parseJump('{"cd":"/a b/it\'s","home":"/h"}\n'), { cd: "/a b/it's", home: "/h" });
  assert.deepEqual(parseJump('{"cd":"/dest"}\n'), { cd: "/dest" });
  assert.throws(() => parseJump("cd '/dest'\nexport WT_HOME='/h'\n"));
  assert.throws(() => parseJump(""));
  assert.throws(() => parseJump('{"cd":""}'));
});

test("isSyncing follows the deps worker's states", () => {
  assert.equal(isSyncing("copying"), true);
  assert.equal(isSyncing("copying 4242"), true);
  assert.equal(isSyncing("linked"), false);
  assert.equal(isSyncing(undefined), false);
});

test("describeWorktree shows what the name alone does not say", () => {
  // feature-auth is wt's directory name for feature/auth: nothing to add
  assert.equal(describeWorktree(worktree()), "");
  assert.equal(describeWorktree(worktree({ name: "main-2", branch: "main-2" })), "");
  assert.equal(describeWorktree(worktree({ name: "api", branch: "feature/auth" })), "feature/auth");
  assert.equal(describeWorktree(worktree({ name: "api", state: "dirty", deps: "copying 7" })), "dirty · syncing deps · feature/auth");
  assert.equal(describeWorktree(worktree({ state: "error" })), "error");
});

test("a dirty worktree shows its uncommitted lines, git style", () => {
  const dirty = (over: Partial<Worktree>) => describeWorktree(worktree({ state: "dirty", ...over }));
  assert.equal(dirty({ files: 3, insertions: 40, deletions: 2 }), "+40 −2");
  assert.equal(dirty({ files: 1, insertions: 7 }), "+7");
  assert.equal(dirty({ files: 1, deletions: 3 }), "−3");
  // dirty with nothing to count (a binary file), or a wt that reports no counts
  assert.equal(dirty({ files: 1 }), "dirty");
  assert.equal(dirty({}), "dirty");
  // counts on a clean worktree would be a CLI bug; they are not shown
  assert.equal(describeWorktree(worktree({ insertions: 5 })), "");
  assert.equal(lineSummary(0, 0), "");
  assert.equal(describeWorktree(worktree({ detached: true, branch: "" })), "detached at 163a116");
  assert.equal(
    describeWorktree(worktree({ kind: "base", name: "staging", branch: "other", pinned: "staging", drifted: true })),
    "drifted from staging · other",
  );
  assert.equal(describeWorktree(worktree({ deps: "failed: no space left" })), "deps failed");
});

test("describeWorktree keeps the commit age on the left and ends with the checkout age", () => {
  const now = new Date("2026-10-02T12:00:00Z");
  const dates = { checkout: "2026-09-29T12:00:00Z", committed: "2026-09-18T12:00:00Z" };
  assert.equal(describeWorktree(worktree({ ...dates }), now), "commit 14d · checkout 3d");
  assert.equal(
    describeWorktree(
      worktree({ ...dates, name: "tickets-app", branch: "feat/category-selector", state: "dirty", insertions: 40, deletions: 2 }),
      now,
    ),
    "+40 −2 · commit 14d · feat/category-selector · checkout 3d",
  );
  // never jumped into: only the commit age
  assert.equal(describeWorktree(worktree({ committed: dates.committed }), now), "commit 14d");
});

test("branchInName spots a branch the directory name already tells", () => {
  assert.equal(branchInName("dev-3", "dev-3"), true);
  assert.equal(branchInName("feature-auth", "feature/auth"), true);
  assert.equal(branchInName("repo-overview-3aca5b", "claude/repo-overview-3aca5b"), true);
  assert.equal(branchInName("claude-fix-2", "claude/fix-2"), true);
  assert.equal(branchInName("tickets-app", "feat/category-selector"), false);
  assert.equal(branchInName("api", "main"), false);
});

test("context values match the menu clauses in package.json", () => {
  const openable = /^wt\.(worktree|peek)\.[a-z]+(\.dirty)?$/;
  const removable = /^wt\.worktree\.(managed|external)(\.dirty)?$/;
  const finishable = /^wt\.worktree\.(managed|external)\.current(\.dirty)?$/;
  const reviewable = /\.dirty$/;

  const other = worktreeContext(worktree());
  assert.ok(openable.test(other) && removable.test(other) && !finishable.test(other) && !reviewable.test(other));

  const here = worktreeContext(worktree({ current: true }));
  assert.ok(!openable.test(here) && !removable.test(here) && finishable.test(here));

  // uncommitted changes add Open Changes and take nothing away
  const otherDirty = worktreeContext(worktree({ state: "dirty" }));
  assert.equal(otherDirty, "wt.worktree.managed.dirty");
  assert.ok(openable.test(otherDirty) && removable.test(otherDirty) && !finishable.test(otherDirty) && reviewable.test(otherDirty));
  const hereDirty = worktreeContext(worktree({ current: true, state: "dirty" }));
  assert.equal(hereDirty, "wt.worktree.managed.current.dirty");
  assert.ok(!openable.test(hereDirty) && !removable.test(hereDirty) && finishable.test(hereDirty) && reviewable.test(hereDirty));
  assert.ok(openable.test(worktreeContext(worktree({ kind: "main", state: "dirty" }))));
  assert.ok(!reviewable.test(peekContext(false)) && !reviewable.test(peekContext(true)));

  for (const kind of ["main", "base"] as const) {
    const context = worktreeContext(worktree({ kind }));
    assert.ok(openable.test(context) && !removable.test(context), context);
    assert.ok(!finishable.test(worktreeContext(worktree({ kind, current: true }))));
  }

  assert.ok(openable.test(peekContext(false)) && !removable.test(peekContext(false)));
  assert.ok(!openable.test(peekContext(true)));
});

test("only regular worktrees are removable", () => {
  assert.equal(isRemovable(worktree({ kind: "managed" })), true);
  assert.equal(isRemovable(worktree({ kind: "external" })), true);
  assert.equal(isRemovable(worktree({ kind: "main" })), false);
  assert.equal(isRemovable(worktree({ kind: "base" })), false);
});

test("age matches the CLI's compact form", () => {
  const now = new Date("2026-10-02T12:00:00Z");
  assert.equal(age("2026-10-02T11:59:30Z", now), "now");
  assert.equal(age("2026-10-02T11:55:00Z", now), "5m");
  assert.equal(age("2026-10-02T09:00:00Z", now), "3h");
  assert.equal(age("2026-09-30T12:00:00Z", now), "2d");
  assert.equal(age("2026-06-02T12:00:00Z", now), "4mo");
  assert.equal(age("2025-01-02T12:00:00Z", now), "1y");
  assert.equal(age(undefined, now), undefined);
  assert.equal(age("not a date", now), undefined);
});

test("statusText can leave the project name out", () => {
  assert.equal(statusText("tickets-app", "dev-3", false, true), "$(wt-logo) tickets-app · dev-3");
  assert.equal(statusText("tickets-app", "dev-3", false, false), "$(wt-logo) dev-3");
  assert.equal(statusText("proj", "peek-HEAD", true, true), "$(eye) proj · peek-HEAD");
  assert.equal(statusText("proj", "peek-HEAD", true, false), "$(eye) peek-HEAD");
});

function snapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    n: 2,
    sha: "b".repeat(40),
    parent: "a".repeat(40),
    message: "snapshot 2",
    created: "2026-10-02T11:55:00Z",
    files: 3,
    insertions: 40,
    deletions: 2,
    ...over,
  };
}

test("parseSnapshots reads the document and rejects the table", () => {
  const doc = parseSnapshots(
    JSON.stringify({
      schema: 1,
      worktree: "/w",
      head: "a".repeat(40),
      series: [{ base: "a".repeat(40), subject: "init", current: true, snapshots: [snapshot()] }],
    }),
  );
  assert.equal(doc.worktree, "/w");
  assert.equal(doc.series[0].snapshots[0].n, 2);
  assert.deepEqual(parseSnapshots('{"schema":1,"worktree":"/w","head":"x","series":[]}').series, []);
  assert.throws(() => parseSnapshots("N  AGE  FILES  MESSAGE  CREATED\n1  now  1 file +1  snapshot 1  2026-10-02 12:00\n"));
  assert.throws(() => parseSnapshots('{"schema":1,"worktrees":[]}'));
});

test("changeSummary reads like the FILES column", () => {
  assert.equal(changeSummary({ files: 3, insertions: 40, deletions: 2 }), "3 files +40 −2");
  assert.equal(changeSummary({ files: 1, insertions: 1, deletions: 0 }), "1 file +1");
  assert.equal(changeSummary({ files: 1, insertions: 0, deletions: 5 }), "1 file −5");
  assert.equal(changeSummary({ files: 1, insertions: 0, deletions: 0 }), "1 file");
  assert.equal(changeSummary({ files: 0, insertions: 0, deletions: 0 }), "no changes");
});

test("describeSnapshot adds the number only when the message does not carry it", () => {
  const now = new Date("2026-10-02T12:00:00Z");
  assert.equal(describeSnapshot(snapshot(), now), "5m ago · 3 files +40 −2");
  assert.equal(describeSnapshot(snapshot({ message: "polish the auth" }), now), "#2 · 5m ago · 3 files +40 −2");
  assert.equal(describeSnapshot(snapshot({ created: "2026-10-02T11:59:50Z" }), now), "now · 3 files +40 −2");
});

test("parseNameStatus splits git's NUL-separated pairs", () => {
  assert.deepEqual(parseNameStatus("M\0README.md\0A\0src/new file.ts\0D\0old.txt\0"), [
    { status: "M", path: "README.md" },
    { status: "A", path: "src/new file.ts" },
    { status: "D", path: "old.txt" },
  ]);
  assert.deepEqual(parseNameStatus(""), []);
  assert.equal(statusWord("A"), "added");
  assert.equal(statusWord("M"), "");
  assert.equal(statusWord("X"), "X");
});

test("parseStatus gives each changed path the letter Source Control shows", () => {
  const out = [
    " M scripts/crawl-categories.ts",
    "M  scripts/build-info-categories.ts",
    "MM scripts/blob-migrate-images.ts",
    "A  src/staged new.ts",
    "AM src/added-then-edited.ts",
    " D gone.txt",
    "D  staged-gone.txt",
    "R  renamed-to.ts",
    "renamed-from.ts",
    "UU both-edited.ts",
    "?? notes.txt",
    "?? dir/untracked.txt",
    "",
  ].join("\0");
  assert.deepEqual(parseStatus(out), [
    { status: "!", path: "both-edited.ts" },
    { status: "U", path: "dir/untracked.txt" },
    { status: "D", path: "gone.txt" },
    { status: "U", path: "notes.txt" },
    { status: "R", path: "renamed-to.ts" },
    { status: "M", path: "scripts/blob-migrate-images.ts" },
    { status: "M", path: "scripts/build-info-categories.ts" },
    { status: "M", path: "scripts/crawl-categories.ts" },
    { status: "A", path: "src/added-then-edited.ts" },
    { status: "A", path: "src/staged new.ts" },
    { status: "D", path: "staged-gone.txt" },
  ]);
  assert.deepEqual(parseStatus(""), []);
});

test("baseBranches are what the base worktrees are pinned to, or the main checkout's branch", () => {
  const doc = (worktrees: Worktree[]) => ({ schema: 1, project: "p", linked: true, root: "/r", worktrees, peeks: [] });
  const main = worktree({ kind: "main", name: "repo", branch: "feat/x", head: "m".repeat(40) });
  const dev = worktree({ kind: "base", name: "dev", branch: "dev", pinned: "dev", head: "d".repeat(40) });
  const staging = worktree({ kind: "base", name: "staging", branch: "other", pinned: "staging", drifted: true, head: "s".repeat(40) });

  // a drifted base is not on its branch, so its head says nothing about it
  assert.deepEqual(baseBranches(doc([main, dev, staging, worktree()])), [{ branch: "dev", sha: "d".repeat(40) }]);
  assert.deepEqual(baseBranches(doc([main, worktree()])), [{ branch: "feat/x", sha: "m".repeat(40) }]);
  assert.deepEqual(baseBranches(doc([worktree()])), []);

  assert.equal(hasParent(worktree()), true);
  assert.equal(hasParent(worktree({ kind: "external" })), true);
  assert.equal(hasParent(main), false);
  assert.equal(hasParent(dev), false);
});

test("pickParent prefers the recorded base branch, else the nearest one", () => {
  const candidates = [
    { branch: "staging", sha: "s", ahead: 9 },
    { branch: "main", sha: "m", ahead: 12 },
    { branch: "dev", sha: "d", ahead: 1 },
  ];
  // recorded and a base branch: taken even though another is nearer
  assert.deepEqual(pickParent(worktree({ base: "main" }), candidates), { branch: "main", sha: "m", ahead: 12, recorded: true });
  // recorded, but a feature branch: the nearest base branch instead
  assert.deepEqual(pickParent(worktree({ base: "claude/other-feature" }), candidates), {
    branch: "dev",
    sha: "d",
    ahead: 1,
    recorded: false,
  });
  // nothing recorded (made by another tool): the nearest
  assert.equal(pickParent(worktree({ kind: "external" }), candidates)?.branch, "dev");
  // never its own branch
  assert.equal(pickParent(worktree({ branch: "dev", base: "dev" }), candidates)?.branch, "staging");
  // a tie goes to the first listed
  assert.equal(pickParent(worktree(), [{ branch: "a", sha: "1", ahead: 0 }, { branch: "b", sha: "2", ahead: 0 }])?.branch, "a");
  assert.equal(pickParent(worktree(), []), undefined);
});

test("parseCommits reads the unit-separated log lines", () => {
  const out =
    "7539c4803a30ba16d8435fdd8b7fad1e91c0ca30\x1ffix(theme): keep the dark palette\x1fKirill G\x1f2026-09-05T10:00:00+02:00\n" +
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\x1f\x1fSomeone\x1f2026-09-01T10:00:00Z\n";
  assert.deepEqual(parseCommits(out), [
    { sha: "7539c4803a30ba16d8435fdd8b7fad1e91c0ca30", subject: "fix(theme): keep the dark palette", author: "Kirill G", date: "2026-09-05T10:00:00+02:00" },
    { sha: "a".repeat(40), subject: "", author: "Someone", date: "2026-09-01T10:00:00Z" },
  ]);
  assert.deepEqual(parseCommits(""), []);
  const now = new Date("2026-10-03T08:00:00Z");
  assert.equal(describeCommit(parseCommits(out)[0], now), "7539c48 · 28d");
  assert.equal(countText(1, "commit"), "1 commit");
  assert.equal(countText(3, "commit"), "3 commits");
});

test("changeLook maps letters to the git extension's colors", () => {
  assert.deepEqual(changeLook("M"), { color: "gitDecoration.modifiedResourceForeground", title: "Modified" });
  assert.equal(changeLook("U").title, "Untracked");
  assert.equal(changeLook("!").color, "gitDecoration.conflictingResourceForeground");
  // an unknown letter still gets a look
  assert.equal(changeLook("T").title, "Modified");
});

test("branchChoices lists local branches, then remote-only ones by their bare name", () => {
  const refs = [
    "refs/heads/main",
    "refs/heads/feature/auth",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
    "refs/remotes/origin/release/2.0",
    "refs/remotes/fork/release/2.0",
    "",
  ].join("\n");
  assert.deepEqual(branchChoices(refs), [
    { label: "main", branch: "main", remote: false },
    { label: "feature/auth", branch: "feature/auth", remote: false },
    { label: "origin/release/2.0", branch: "release/2.0", remote: true },
  ]);
  assert.deepEqual(branchChoices(""), []);
});
