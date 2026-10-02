import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Cli, WtError, findBinary, narration, parseFailure } from "./cli";

test("parseFailure takes the last wt: line and the hint after it", () => {
  assert.deepEqual(
    parseFailure("wt: 2 snapshot(s) in 'api' go with it\nwt: fatal: 'api' contains modified files\nhint: wt rm -f api discards them\n"),
    { message: "fatal: 'api' contains modified files", hint: "wt rm -f api discards them" },
  );
  assert.deepEqual(parseFailure("wt: not inside a git repository\n"), {
    message: "not inside a git repository",
    hint: undefined,
  });
  assert.deepEqual(parseFailure(""), { message: "the command failed", hint: undefined });
  assert.deepEqual(parseFailure("panic: boom\n"), { message: "panic: boom", hint: undefined });
});

test("a hint from an earlier line does not stick to a later error", () => {
  assert.deepEqual(parseFailure("wt: first\nhint: old\nwt: second\n"), { message: "second", hint: undefined });
});

test("narration strips the wt: prefix", () => {
  assert.deepEqual(narration("wt: created worktree 'x' at /p\n  x  (branch y)\n\n"), [
    "created worktree 'x' at /p",
    "  x  (branch y)",
  ]);
});

test("forceable only when the hint names the force flag", () => {
  assert.equal(new WtError("failed", "dirty", "wt rm -f api discards them").forceable, true);
  assert.equal(new WtError("failed", "syncing", "wait for it, or discard with: wt finish -d -f").forceable, true);
  assert.equal(new WtError("failed", "unmerged", "git branch -D api discards it").forceable, false);
  assert.equal(new WtError("failed", "base", "wt base rm staging").forceable, false);
  assert.equal(new WtError("failed", "no hint").forceable, false);
});

test("findBinary prefers the setting, then PATH, then the usual install dirs", async () => {
  const only = (...files: string[]) => async (file: string) => files.includes(file);
  const env = { PATH: ["/a", "/b"].join(path.delimiter) };

  assert.equal(await findBinary("/custom/worktree", env, "/home/u", only("/custom/worktree", "/a/worktree")), "/custom/worktree");
  assert.equal(await findBinary("~/bin/worktree", env, "/home/u", only("/home/u/bin/worktree")), "/home/u/bin/worktree");
  // a configured path that is wrong is reported, not silently replaced
  assert.equal(await findBinary("/nope", env, "/home/u", only("/a/worktree")), undefined);

  assert.equal(await findBinary("", env, "/home/u", only("/b/worktree", "/usr/local/bin/worktree")), "/b/worktree");
  assert.equal(await findBinary("", env, "/home/u", only("/home/u/.local/bin/worktree")), "/home/u/.local/bin/worktree");
  assert.equal(await findBinary("", {}, "/home/u", only("/opt/homebrew/bin/worktree")), "/opt/homebrew/bin/worktree");
  assert.equal(await findBinary("", env, "/home/u", only()), undefined);
});

/** A stand-in binary: a shell script that plays one scripted response. */
function fakeBinary(script: string): Cli {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "wt-fake-")), "worktree");
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
  return new Cli({ binary: async () => file, log: () => {} });
}

async function failure(run: Promise<unknown>): Promise<WtError> {
  try {
    await run;
  } catch (err) {
    assert.ok(err instanceof WtError, String(err));
    return err;
  }
  throw new Error("expected the command to fail");
}

test("run reports a missing binary", async () => {
  const cli = new Cli({ binary: async () => undefined, log: () => {} });
  assert.equal((await failure(cli.run(["list"], tmpdir()))).kind, "missing");
});

test("run sets the integration environment and drops the wrapper's", async () => {
  process.env.WT_PREV = "/leaked";
  try {
    const cli = fakeBinary('echo "$WT_JUMP|$NO_COLOR|${WT_PREV:-unset}|$*"');
    assert.equal(await cli.run(["checkout", "x"], tmpdir()), "json|1|unset|checkout x\n");
    assert.equal(await cli.run(["finish"], tmpdir(), { WT_PREV: "/prev" }), "json|1|/prev|finish\n");
  } finally {
    delete process.env.WT_PREV;
  }
});

test("run turns exit 1 into a WtError with message and hint, logging narration", async () => {
  const lines: string[] = [];
  const cli = fakeBinary('echo "wt: you are inside \'api\'" >&2; echo "hint: wt ch proj first" >&2; exit 1');
  (cli as unknown as { options: { log(line: string): void } }).options.log = (line) => lines.push(line);
  const err = await failure(cli.run(["remove", "api"], tmpdir()));
  assert.equal(err.kind, "failed");
  assert.equal(err.message, "you are inside 'api'");
  assert.equal(err.hint, "wt ch proj first");
  assert.deepEqual(lines, ["you are inside 'api'", "hint: wt ch proj first"]);
});

test("a confirmation prompt sees EOF instead of hanging", async () => {
  const cli = fakeBinary('if read answer; then echo "answered"; else echo "eof"; fi');
  assert.equal(await cli.run(["deps", "purge"], tmpdir()), "eof\n");
});

test("list classifies not-a-repo and a binary from before --json", async () => {
  assert.equal((await failure(fakeBinary('echo "wt: not inside a git repository" >&2; exit 1').list(tmpdir()))).kind, "norepo");
  assert.equal((await failure(fakeBinary('echo "wt: usage: wt list" >&2; exit 1').list(tmpdir()))).kind, "outdated");
  assert.equal((await failure(fakeBinary('echo "  NAME  BRANCH"').list(tmpdir()))).kind, "outdated");
});

test("snapshots flags a binary from before snap ls --json", async () => {
  const old = fakeBinary('echo "wt: usage: wt snap ls [--all | <commit>]" >&2; exit 1');
  assert.equal((await failure(old.snapshots(tmpdir()))).kind, "outdated");
  const peek = fakeBinary('echo "wt: snapshots need a real worktree" >&2; exit 1');
  assert.equal((await failure(peek.snapshots(tmpdir()))).kind, "failed");
});

test("jump parses the JSON line and flags a binary that still prints shell code", async () => {
  assert.deepEqual(await fakeBinary(`echo '{"cd":"/w/x","home":"/repo"}'`).jump(["checkout", "x"], tmpdir()), {
    cd: "/w/x",
    home: "/repo",
  });
  assert.equal((await failure(fakeBinary(`echo "cd '/w/x'"`).jump(["checkout", "x"], tmpdir()))).kind, "outdated");
  assert.equal((await failure(fakeBinary("true").jump(["create"], tmpdir()))).kind, "failed");
});

// Against the real binary, when the test run provides one: WT_TEST_BINARY=…/worktree
test("the real binary's list --json and jumps parse", { skip: !process.env.WT_TEST_BINARY }, async () => {
  const binary = process.env.WT_TEST_BINARY!;
  const cli = new Cli({ binary: async () => binary, log: () => {} });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).toString();

  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "wt-real-")));
  const repo = path.join(base, "repo");
  process.env.WT_ROOT = path.join(base, "worktrees");
  try {
    git(base, "init", "-q", "-b", "main", repo);
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "initial");
    await cli.run(["link", "proj"], repo);

    const jump = await cli.jump(["create", "-c", "--no-deps"], repo);
    assert.equal(jump.cd, path.join(base, "worktrees", "proj", "main-2"));
    assert.equal(jump.home, repo);

    const doc = await cli.list(repo);
    assert.equal(doc.project, "proj");
    assert.equal(doc.linked, true);
    assert.deepEqual(
      doc.worktrees.map((w) => [w.name, w.kind, w.current]),
      [
        ["repo", "main", true],
        ["main-2", "managed", false],
      ],
    );
    assert.equal(doc.worktrees[1].base, "main");
    assert.equal(doc.worktrees[1].path, jump.cd);

    // seen from inside the new worktree, it is the current one
    assert.equal((await cli.list(jump.cd)).worktrees.find((w) => w.current)?.name, "main-2");

    const inside = await failure(cli.run(["remove", "main-2"], jump.cd));
    assert.match(inside.message, /you are inside/);

    writeFileSync(path.join(jump.cd, "wip.txt"), "x");
    const dirty = await failure(cli.run(["remove", "main-2"], repo));
    assert.equal(dirty.forceable, true);

    // snapshots: none, then one with a message that would read as a subcommand
    assert.deepEqual((await cli.snapshots(jump.cd)).series, []);
    const { notes } = await cli.runWithNotes(["snapshot", "-m", "diff the parser"], jump.cd);
    assert.match(notes[notes.length - 1], /^snapshot 1 recorded \(1 file \+1\)$/);
    const snaps = await cli.snapshots(jump.cd);
    assert.equal(snaps.worktree, jump.cd);
    assert.equal(snaps.series.length, 1);
    assert.equal(snaps.series[0].current, true);
    const [first] = snaps.series[0].snapshots;
    assert.deepEqual([first.n, first.message, first.files, first.parent], [1, "diff the parser", 1, snaps.head]);
    assert.equal(git(jump.cd, "show", `${first.sha}:wip.txt`), "x");
    // nothing changed since: the diff the extension asks for is empty
    assert.equal(await cli.run(["snap", "diff", "--name-status", "-z", "--no-renames"], jump.cd), "");
    writeFileSync(path.join(jump.cd, "more.txt"), "y");
    assert.equal(await cli.run(["snap", "diff", "--name-status", "-z", "--no-renames"], jump.cd), "A\0more.txt\0");

    const back = await cli.jump(["finish", "-d", "-b", "-f"], jump.cd, { WT_PREV: repo });
    assert.equal(back.cd, repo);
    assert.equal((await cli.list(repo)).worktrees.length, 1);

    assert.equal((await failure(cli.list(base))).kind, "norepo");
  } finally {
    delete process.env.WT_ROOT;
  }
});
