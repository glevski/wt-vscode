// The bridge to the `worktree` binary: find it, run it, and turn its
// stdout/stderr contract into values and typed errors. No vscode import.
//
// The contract (see internal/cli/cli.go): stdout is machine output, stderr
// is narration prefixed "wt: ", a failure exits 1 with "wt: <message>" and an
// optional "hint: <hint>" line after it.

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import * as path from "node:path";
import { Jump, ListDoc, SnapshotDoc, parseJump, parseList, parseSnapshots } from "./model";

export type FailureKind =
  /** The worktree binary could not be found or started. */
  | "missing"
  /** The binary predates `list --json` / WT_JUMP=json. */
  | "outdated"
  /** The folder is not inside a git repository. */
  | "norepo"
  /** The command ran and said no. */
  | "failed";

export class WtError extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "WtError";
  }

  /** The CLI's hint names a force flag: retrying with -f would go through. */
  get forceable(): boolean {
    return this.hint !== undefined && /(^|\s)-f(\s|$)/.test(this.hint);
  }
}

/** Narration lines without their "wt: " prefix. */
export function narration(stderr: string): string[] {
  return stderr
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "")
    .map((line) => (line.startsWith("wt: ") ? line.slice(4) : line));
}

/** The error and hint of a failed run: the last "wt: " line and the "hint: " after it. */
export function parseFailure(stderr: string): { message: string; hint?: string } {
  const lines = stderr
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");
  let message: string | undefined;
  let hint: string | undefined;
  for (const line of lines) {
    if (line.startsWith("wt: ")) {
      message = line.slice(4);
      hint = undefined;
    } else if (line.startsWith("hint: ") && message !== undefined) {
      hint = line.slice(6);
    }
  }
  if (message === undefined) {
    message = lines.length > 0 ? lines[lines.length - 1] : "the command failed";
  }
  return { message, hint };
}

function classify(message: string): FailureKind {
  if (message.startsWith("not inside a git repository")) {
    return "norepo";
  }
  return "failed";
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Locates the worktree binary: the configured path when there is one,
 * otherwise PATH and then the usual install locations — an editor started
 * from a dock or launcher often has a shorter PATH than a login shell.
 */
export async function findBinary(
  configured: string,
  env: NodeJS.ProcessEnv,
  home: string,
  executable: (file: string) => Promise<boolean> = isExecutable,
): Promise<string | undefined> {
  const wanted = configured.trim();
  if (wanted !== "") {
    let file = wanted;
    if (file === "~" || file.startsWith("~/")) {
      file = path.join(home, file.slice(1));
    }
    return (await executable(file)) ? file : undefined;
  }
  const dirs = [
    ...(env.PATH ?? "").split(path.delimiter).filter((dir) => dir !== ""),
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of dirs) {
    const candidate = path.join(dir, "worktree");
    if (await executable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Set when the process could not be started at all. */
  spawnError?: { code: string | undefined; message: string };
}

function exec(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { cwd, env, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ code: 0, stdout, stderr });
        } else if (typeof error.code === "number") {
          resolve({ code: error.code, stdout, stderr });
        } else {
          const code = typeof error.code === "string" ? error.code : undefined;
          resolve({ code: -1, stdout, stderr, spawnError: { code, message: error.message } });
        }
      },
    );
    // wt's y/N prompts read stdin; an editor has no one to answer, so they
    // must see EOF and abort rather than wait forever.
    child.stdin?.end();
  });
}

/** Runs any program and returns its stdout; rejects on a non-zero exit. */
export async function execText(file: string, args: string[], cwd: string): Promise<string> {
  const result = await exec(file, args, cwd, process.env);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.spawnError?.message || `${file} failed`);
  }
  return result.stdout;
}

export interface CliOptions {
  /** Resolves the binary, undefined when it is not installed. */
  binary(): Promise<string | undefined>;
  log(line: string): void;
}

export class Cli {
  constructor(private readonly options: CliOptions) {}

  /** Runs one wt command in cwd and returns its stdout. */
  async run(args: string[], cwd: string, env: Record<string, string> = {}): Promise<string> {
    return (await this.runWithNotes(args, cwd, env)).stdout;
  }

  /** Like run, but also hands back the narration — for commands whose result is only said, not printed. */
  async runWithNotes(args: string[], cwd: string, env: Record<string, string> = {}): Promise<{ stdout: string; notes: string[] }> {
    const binary = await this.options.binary();
    if (binary === undefined) {
      throw new WtError("missing", "the wt CLI (the worktree binary) was not found");
    }
    // WT_PREV and WT_WRAPPER_VERSION belong to the shell wrapper's protocol;
    // only what the caller passes on purpose may reach the binary.
    const { WT_PREV: _prev, WT_WRAPPER_VERSION: _wrapper, ...inherited } = process.env;
    const result = await exec(binary, args, cwd, {
      ...inherited,
      NO_COLOR: "1",
      WT_JUMP: "json",
      ...env,
    });
    if (result.spawnError !== undefined) {
      const kind = result.spawnError.code === "ENOENT" ? "missing" : "failed";
      throw new WtError(kind, `could not run ${binary}: ${result.spawnError.message}`);
    }
    const notes = narration(result.stderr);
    for (const line of notes) {
      this.options.log(line);
    }
    if (result.code !== 0) {
      const { message, hint } = parseFailure(result.stderr);
      throw new WtError(classify(message), message, hint);
    }
    return { stdout: result.stdout, notes };
  }

  /** Every snapshot series of the worktree containing cwd: `wt snap ls --all --json`. */
  async snapshots(cwd: string): Promise<SnapshotDoc> {
    let stdout: string;
    try {
      stdout = await this.run(["snap", "ls", "--all", "--json"], cwd);
    } catch (err) {
      // a binary from before --json answers with its usage line
      if (err instanceof WtError && err.kind === "failed" && err.message.startsWith("usage: wt snap ls")) {
        throw new WtError("outdated", "this wt is too old: it has no `wt snap ls --json`");
      }
      throw err;
    }
    try {
      return parseSnapshots(stdout);
    } catch {
      throw new WtError("outdated", "this wt printed a snapshot list the extension cannot read");
    }
  }

  /** `wt list --json` as seen from cwd. */
  async list(cwd: string): Promise<ListDoc> {
    let stdout: string;
    try {
      stdout = await this.run(["list", "--json"], cwd);
    } catch (err) {
      // a binary from before --json answers with its usage line
      if (err instanceof WtError && err.kind === "failed" && err.message.startsWith("usage: wt list")) {
        throw new WtError("outdated", "this wt is too old: it has no `wt list --json`");
      }
      throw err;
    }
    try {
      return parseList(stdout);
    } catch {
      throw new WtError("outdated", "this wt printed a worktree list the extension cannot read");
    }
  }

  /** Runs a jump command (checkout, create -c, fork -c, finish, …). */
  async jump(args: string[], cwd: string, env: Record<string, string> = {}): Promise<Jump> {
    const stdout = await this.run(args, cwd, env);
    try {
      return parseJump(stdout);
    } catch {
      // a binary from before WT_JUMP=json prints the shell script instead
      const kind = stdout.startsWith("cd ") ? "outdated" : "failed";
      throw new WtError(kind, `wt ${args[0]} did not report where to go`);
    }
  }
}
