# Plan: a worktree's history relative to its parent

Status: **postponed** (drafted 2026-10-02). The phases below are not built.

Built since, in 0.1.2, as a smaller cut of the same idea: each worktree row
unfolds into the commits it has on top of its parent branch (`src/history.ts`).
That version resolves the parent inside the extension — the recorded base when
it is a base branch, else the nearest base branch — and shows only the
worktree's side. No `wt commits` command, no behind count, no fork point, no
manual "Compare with…".

## Goal

For any worktree, show what it did relative to where it came from: the commits
it has that its parent branch does not, the commits the parent gained since,
and the point where they split — the scoped equivalent of a Git Graph view,
opened from the wt sidebar.

Not a goal: a general repository graph (all branches, remotes, stashes,
search). Git Graph already does that.

## Decisions to make before starting

1. **Size.** Build the commit list only (phase 1), or the list and then the
   drawn graph (phase 2). Recommended: phase 1 first; phase 2 only if the list
   turns out not to be enough.
2. **Parent for worktrees without a recorded one.** wt records a base only
   when it creates the branch itself (`fork`, `create` with a new branch). In
   `tickets-app` on 2026-10-02 that was 3 of 14 worktrees; the ones made by
   other tools have none. Options: guess the nearest base branch by merge-base
   (recommended), or ask once per worktree.
3. **Where a manual choice is stored.** In the extension only (recommended), or
   written to wt's recorded base. The second also changes what `wt reset`
   resets to, so it should not happen as a side effect of a view.
4. **Name of the new CLI command** (working name below: `wt commits`).

## Phase 0 — CLI: one read-only command (about half a day)

`wt commits [name] [--parent <ref>] --json`: everything both later phases need,
for the named worktree (default: the current one).

- **Resolve the parent**, in this order, and say which rule applied:
  1. `--parent <ref>` → `given`
  2. the recorded base (`git.BaseBranch`, the `wt-base` file), if it still
     resolves → `recorded`
  3. a guess → `guessed`: among the base worktrees' branches, the main
     checkout's branch and the remote default branch, the one with the fewest
     commits between it and HEAD (`git rev-list --count <candidate>..HEAD`),
     never the worktree's own branch
  4. none → `"parent": null`, and the extension offers "Compare with…"
- **Collect the commits** with one git call:
  `git log --boundary --left-right --topo-order --max-count=<cap>
  --format=%m%x00%H%x00%P%x00%an%x00%cI%x00%D%x00%s <parent>...HEAD`
  (`%m` is `>` for the worktree's side, `<` for the parent's side, `-` for the
  fork point).
- **Output:**

```json
{
  "schema": 1,
  "worktree": "/…/dev-3", "branch": "dev-3", "head": "<sha>",
  "parent": { "ref": "dev", "sha": "<sha>", "source": "recorded" },
  "mergeBase": "<sha>",
  "ahead": 3, "behind": 12, "truncated": false,
  "commits": [
    { "sha": "…", "parents": ["…"], "side": "ahead|behind|boundary",
      "subject": "…", "author": "…", "date": "…", "refs": ["dev-3"] }
  ]
}
```

- Files: a new `internal/cli/commits.go` next to
  [snapshot.go](../../../internal/cli/snapshot.go) (same JSON conventions as
  `writeSnapshotsJSON`), dispatch and usage in
  [cli.go](../../../internal/cli/cli.go), completion in
  [complete.go](../../../internal/cli/complete.go), README and skill.
- Tests: recorded parent, guessed parent, `--parent`, a deleted recorded base
  falling back to a guess, a merge from the parent into the branch, detached
  HEAD, a worktree with no possible parent.

## Phase 1 — extension: Commits section in the sidebar (about half a day)

A third view under Snapshots, titled like `Commits (dev-3 ← dev)`, for the
worktree the window has open.

- Rows, top to bottom: uncommitted changes (the counts `wt list --json` already
  carries); commits ahead, newest first, each unfolding into its files with
  diffs; the fork point; a collapsed `12 behind dev` group.
- Title actions: **Compare with…** (pick another parent), **Open All Changes**
  (every file changed since the fork point in one diff view — the pull-request
  view of the worktree), refresh.
- Reuse from [snapshots.ts](../src/snapshots.ts): the `wt-snap` content
  provider and `revisionUri` (move to a shared module), the name-status parsing
  and the multi-file diff rows, the visible-only refresh in `SnapshotStore`.
- Add `refs/heads/**` to the watcher in [store.ts](../src/store.ts) so the view
  follows the parent branch moving.
- Tests: parsing and row text as unit tests in `model.test.ts`; the real binary
  in `cli.test.ts`.

## Phase 2 — extension: drawn graph in an editor tab (one to two days)

A webview panel opened from a worktree row ("Show Graph"), for any worktree,
fed by the same `wt commits <name> --json`.

- Lane layout as a pure function over the topo-ordered commits (two lanes in
  the common case, more with merges) — unit-testable without an editor.
- Rendering: SVG rails and dots, ref labels, columns for description, date,
  author and commit as in Git Graph; colours from the editor's CSS variables;
  a strict content-security policy; click → the same file diffs as phase 1.
- "Load more" past the cap instead of virtual scrolling.
- This is the first webview in the extension and cannot be checked without a
  real editor window: expect several rounds of screenshots.

## Edge cases to keep in mind

- A recorded base can be a remote ref (`origin/x`) or a branch that no longer
  exists.
- The main checkout and base worktrees have no parent by design; a base
  worktree could instead be compared with its upstream.
- Merge commits in the ahead list diff against their first parent.
- A parent far ahead (thousands behind): cap the list, keep the counts exact
  via `git rev-list --left-right --count`.
