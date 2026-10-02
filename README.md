# wt - git worktrees

[wt](https://wt.glevski.com) in the sidebar of Cursor and VS Code: see every
worktree of the repository you have open, jump between them, and create, fork
or remove them without leaving the editor.

The extension is a thin layer over the `wt` CLI — it runs the same
`worktree` binary you use in the terminal, so both always agree.

## Requirements

- The `wt` CLI with `wt list --json` and `wt snap ls --json` (any release after 0.0.18).
  Install: `curl -fsSL https://github.com/glevski/wt/raw/main/install.sh | sh`
- The binary must be on the machine the repository is on. Over SSH or in a
  dev container that is the remote side — the extension runs there too.

## What you get

**Worktrees tab** in the activity bar — its own sidebar, next to Explorer and
Source Control (drag the icon to reorder it). It lists the worktrees in the
same order as `wt list`: the main checkout, base worktrees, then the rest by
most recent use, then peeks. Colors match the CLI.

| Icon | Kind |
|---|---|
| house, cyan | main checkout |
| lock, orange | base worktree |
| branch, green | worktree made by wt |
| folder, magenta | worktree made by another tool |
| eye, red | peek |
| spinner | dependencies still syncing in the background |

The worktree this window has open is highlighted. Next to each name: `+40 −2`
for its uncommitted changes (untracked files counted in), `commit 2w` for the
age of its last commit, the branch when the directory name does not already
say it, and at the end `checkout 3d` for when you last jumped into it. Hover
a row for its path, branch, base, changed-file count and deps state.

**Snapshots section** below the list, titled with the worktree it shows —
`Snapshots (dev-3)`: the `wt snap` records of the worktree this window has
open, newest first. Unfold a snapshot to see the files it
changed; click a file for the diff against the snapshot before it. Snapshots
taken on earlier commits fold under their commit. The title bar has
**Snapshot Now** and **Show Changes Since Last Snapshot** — what you changed
since you last recorded, untracked files included.

**Commands** (Command Palette, prefix `wt:`):

| Command | Does |
|---|---|
| Switch Worktree… | pick a worktree and open it — `wt ch` |
| New Worktree… | for an existing branch, or a fresh branch off HEAD — `wt create` |
| Fork Current Changes into a New Worktree… | carries staged, unstaged and untracked changes over — `wt fork` |
| Remove Worktree… | `wt rm`, optionally deleting the branch |
| Finish This Worktree… | go back to where this window came from, optionally removing the worktree — `wt finish` |
| Go to Main Checkout | `wt home` |
| Link Repository to a Project Name… | `wt link` |
| Snapshot Now… | record a snapshot, with an optional message — `wt snap` |
| Show Changes Since Last Snapshot | all files changed since the latest snapshot, in one diff view — `wt snap diff` |

Each row has **Open** and **Open in New Window** buttons; right-click for the
rest. The status bar shows `<project> · <worktree>` and opens the switcher.

The view follows changes made anywhere: `wt` or `git` commands typed in the
integrated terminal, another window, or a plain shell.

## Settings

| Setting | Default | |
|---|---|---|
| `wt.path` | empty | Path to the `worktree` binary. Empty: `PATH`, then `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`. |
| `wt.openIn` | `currentWindow` | Where a worktree opens after Switch, New Worktree and Fork: `currentWindow` or `newWindow`. |
| `wt.statusBar.showProject` | `true` | Show `project · worktree` in the status bar; off shows the worktree name alone. |

## Not yet

Purging snapshots, base-worktree management, peeks beyond opening them, disk
usage and the cross-project list are still terminal-only. One repository per
window: the first workspace folder.

## Development

```sh
npm install
npm test          # typecheck + unit tests
npm run package   # builds builds/wt-<version>.vsix (the folder is git-ignored)
```

`WT_TEST_BINARY=/path/to/worktree npm test` also runs the tests that drive a
real binary.
