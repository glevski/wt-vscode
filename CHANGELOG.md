# Changelog

## 0.1.2

- A worktree with uncommitted changes unfolds into its changed files, with status letters and diffs, like the Changes group of Source Control.
- Open Changes on a worktree row: all of its changed files in one diff editor.
- Below the changes, the commits a worktree has on top of its parent base branch; click one to see what it changed.
- Files of other worktrees open as read-only copies, so the Git extension no longer asks to open their repository.
- Reading state no longer lets git refresh its index as a side effect.

## 0.1.1

- MIT licence, included in the package.
- The title is "wt - git worktrees", with a plain hyphen.

## 0.1.0

First version.

- Worktrees tab in the activity bar, mirroring `wt list`, with uncommitted `+N −M`, checkout and commit ages on each row.
- Snapshots section: the current worktree's `wt snap` records, their files and diffs; Snapshot Now; changes since the last snapshot.
- Switch, open in a new window, new worktree, fork, remove, finish, go home, link.
- Status bar item with the current project and worktree.
- Follows changes made in the terminal or other windows.
