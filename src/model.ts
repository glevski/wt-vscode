// The shapes the wt CLI prints (`worktree list --json`, and jumps under
// WT_JUMP=json) plus the pure view logic derived from them. No vscode import:
// everything here runs under plain node in the unit tests.

export type Kind = "main" | "base" | "managed" | "external";

export interface Worktree {
  name: string;
  path: string;
  branch: string;
  head: string;
  detached: boolean;
  kind: Kind;
  current: boolean;
  state: "clean" | "dirty" | "error" | "bare";
  deps?: string;
  base?: string;
  pinned?: string;
  drifted: boolean;
  created?: string;
  /** When wt last jumped into it. */
  checkout?: string;
  /** Committer date of its head commit. */
  committed?: string;
  /** Uncommitted changes of a dirty worktree, untracked files included. */
  files?: number;
  insertions?: number;
  deletions?: number;
}

export interface Peek {
  name: string;
  path: string;
  rev: string;
  sha: string;
  source: string;
  created?: string;
  deps?: string;
}

export interface ListDoc {
  schema: number;
  project: string;
  linked: boolean;
  root: string;
  worktrees: Worktree[];
  peeks: Peek[];
}

export interface Jump {
  cd: string;
  home?: string;
}

/** The schema this extension understands; newer ones only add fields. */
export const SCHEMA = 1;

export function parseList(stdout: string): ListDoc {
  const doc = JSON.parse(stdout) as Partial<ListDoc>;
  if (
    typeof doc !== "object" ||
    doc === null ||
    typeof doc.schema !== "number" ||
    !Array.isArray(doc.worktrees)
  ) {
    throw new Error("unexpected `wt list --json` output");
  }
  return { ...doc, peeks: doc.peeks ?? [] } as ListDoc;
}

export function parseJump(stdout: string): Jump {
  const jump = JSON.parse(stdout.trim()) as Partial<Jump>;
  if (typeof jump !== "object" || jump === null || typeof jump.cd !== "string" || jump.cd === "") {
    throw new Error("unexpected jump output");
  }
  return jump as Jump;
}

/** The background deps copy is still running. */
export function isSyncing(deps: string | undefined): boolean {
  return deps !== undefined && deps.startsWith("copying");
}

export function depsFailed(deps: string | undefined): boolean {
  return deps !== undefined && deps.startsWith("failed");
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** "+40 −2", the way git and GitHub sum up a change; empty when there are no lines to count. */
export function lineSummary(insertions: number, deletions: number): string {
  const parts: string[] = [];
  if (insertions > 0) {
    parts.push(`+${insertions}`);
  }
  if (deletions > 0) {
    parts.push(`−${deletions}`);
  }
  return parts.join(" ");
}

/**
 * The directory name already says the branch: they are equal, the directory
 * is wt's flattened form of it (feature/auth → feature-auth), or it is the
 * branch's last segment (claude/fix-login in a directory fix-login).
 */
export function branchInName(name: string, branch: string): boolean {
  return branch === name || branch.replace(/[/\\:*?"<>| ]/g, "-") === name || branch.endsWith(`/${name}`);
}

/**
 * What a worktree row says next to its name: state and the age of the last
 * commit on the left, then the branch, and the checkout age as the last thing
 * on the row. A sidebar cuts the text off at the right, so in a narrow one
 * the checkout age is the first to go; the tooltip still has it.
 */
export function describeWorktree(w: Worktree, now: Date = new Date()): string {
  const parts: string[] = [];
  if (w.state === "dirty") {
    // "+40 −2" says dirty and how dirty; the bare word is left for changes
    // without lines to count (a binary file, a mode change)
    parts.push(lineSummary(w.insertions ?? 0, w.deletions ?? 0) || "dirty");
  } else if (w.state === "error") {
    parts.push(w.state);
  }
  if (isSyncing(w.deps)) {
    parts.push("syncing deps");
  } else if (depsFailed(w.deps)) {
    parts.push("deps failed");
  }
  if (w.drifted) {
    parts.push(`drifted from ${w.pinned}`);
  }
  const committed = age(w.committed, now);
  if (committed !== undefined) {
    parts.push(`commit ${committed}`);
  }
  if (w.detached) {
    parts.push(`detached at ${shortSha(w.head)}`);
  } else if (w.branch !== "" && !branchInName(w.name, w.branch)) {
    parts.push(w.branch);
  }
  const checkout = age(w.checkout, now);
  if (checkout !== undefined) {
    parts.push(`checkout ${checkout}`);
  }
  return parts.join(" · ");
}

export function describePeek(p: Peek): string {
  const parts = [`peek at ${p.rev}`];
  if (isSyncing(p.deps)) {
    parts.push("syncing deps");
  }
  return parts.join(" · ");
}

/**
 * The tree item's contextValue, matched by the menu `when` clauses in
 * package.json: wt.worktree.<kind>, with a .current suffix for the worktree
 * this window has open.
 */
export function worktreeContext(w: Worktree): string {
  return `wt.worktree.${w.kind}${w.current ? ".current" : ""}`;
}

export function peekContext(current: boolean): string {
  return `wt.peek.peek${current ? ".current" : ""}`;
}

/** Only regular worktrees are removable — never the main checkout or a base. */
export function isRemovable(w: Worktree): boolean {
  return w.kind === "managed" || w.kind === "external";
}

/** A compact age like the CLI's: now, 5m, 3h, 2d, 4mo, 1y. */
export function age(iso: string | undefined, now: Date = new Date()): string | undefined {
  if (iso === undefined) {
    return undefined;
  }
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return undefined;
  }
  const minutes = Math.floor((now.getTime() - then) / 60_000);
  if (minutes < 1) {
    return "now";
  }
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days < 30) {
    return `${days}d`;
  }
  if (days < 365) {
    return `${Math.floor(days / 30)}mo`;
  }
  return `${Math.floor(days / 365)}y`;
}

/**
 * The status bar text: "<project> · <worktree>", or the worktree alone.
 * $(wt-logo) is the wt mark, contributed as an icon font in package.json.
 */
export function statusText(project: string, name: string, peek: boolean, showProject: boolean): string {
  const icon = peek ? "$(eye)" : "$(wt-logo)";
  return showProject ? `${icon} ${project} · ${name}` : `${icon} ${name}`;
}

// ---- snapshots: `worktree snap ls --json` ----

export interface Snapshot {
  n: number;
  sha: string;
  /** What it diffs against: the snapshot before it, or the series' base commit. */
  parent: string;
  message: string;
  created: string;
  files: number;
  insertions: number;
  deletions: number;
}

export interface Series {
  /** The commit the series sits on. */
  base: string;
  subject: string;
  current: boolean;
  /** Newest first. */
  snapshots: Snapshot[];
}

export interface SnapshotDoc {
  schema: number;
  /** The worktree's root: snapshot paths are relative to it. */
  worktree: string;
  head: string;
  series: Series[];
}

export function parseSnapshots(stdout: string): SnapshotDoc {
  const doc = JSON.parse(stdout) as Partial<SnapshotDoc>;
  if (
    typeof doc !== "object" ||
    doc === null ||
    typeof doc.schema !== "number" ||
    typeof doc.worktree !== "string" ||
    !Array.isArray(doc.series)
  ) {
    throw new Error("unexpected `wt snap ls --json` output");
  }
  return doc as SnapshotDoc;
}

/** "3 files +40 −2", like the FILES column of `wt snap ls`. */
export function changeSummary(s: Pick<Snapshot, "files" | "insertions" | "deletions">): string {
  if (s.files === 0) {
    return "no changes";
  }
  const lines = lineSummary(s.insertions, s.deletions);
  return `${s.files} file${s.files === 1 ? "" : "s"}${lines !== "" ? ` ${lines}` : ""}`;
}

/** What a snapshot row says next to its message. */
export function describeSnapshot(s: Snapshot, now: Date = new Date()): string {
  const parts: string[] = [];
  if (s.message !== `snapshot ${s.n}`) {
    parts.push(`#${s.n}`); // the default message already carries the number
  }
  const when = age(s.created, now);
  if (when !== undefined) {
    parts.push(when === "now" ? "now" : `${when} ago`);
  }
  parts.push(changeSummary(s));
  return parts.join(" · ");
}

export interface FileChange {
  /** git's status letter: A, M, D, T, … */
  status: string;
  /** Relative to the worktree root. */
  path: string;
}

/** Parses `git diff --name-status -z --no-renames`: status NUL path NUL … */
export function parseNameStatus(out: string): FileChange[] {
  const fields = out.split("\0");
  const changes: FileChange[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] !== "" && fields[i + 1] !== "") {
      changes.push({ status: fields[i][0], path: fields[i + 1] });
    }
  }
  return changes;
}

export function statusWord(status: string): string {
  return ({ A: "added", D: "deleted", M: "", T: "type changed" } as Record<string, string>)[status] ?? status;
}

/** A branch offered by New Worktree: what to show and what to pass to wt. */
export interface BranchChoice {
  label: string;
  /** The argument for `wt create`. */
  branch: string;
  remote: boolean;
}

/**
 * Turns `git for-each-ref --format=%(refname)` output into choices: every
 * local branch, then remote branches that have no local counterpart (wt
 * creates the tracking branch for those).
 */
export function branchChoices(refs: string): BranchChoice[] {
  const local: BranchChoice[] = [];
  const remote: BranchChoice[] = [];
  const names = new Set<string>();
  const lines = refs.split("\n").map((l) => l.trim());
  for (const ref of lines) {
    if (ref.startsWith("refs/heads/")) {
      const branch = ref.slice("refs/heads/".length);
      names.add(branch);
      local.push({ label: branch, branch, remote: false });
    }
  }
  for (const ref of lines) {
    if (!ref.startsWith("refs/remotes/")) {
      continue;
    }
    const short = ref.slice("refs/remotes/".length);
    const slash = short.indexOf("/");
    if (slash < 0) {
      continue;
    }
    const branch = short.slice(slash + 1);
    if (branch === "HEAD" || names.has(branch)) {
      continue;
    }
    names.add(branch);
    remote.push({ label: short, branch, remote: true });
  }
  return [...local, ...remote];
}
