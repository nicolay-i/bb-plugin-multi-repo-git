# Multi Repo Git

Explicit multi-repository workspaces and environment-local Source Control for BB, without replacing the native sidebar or managing worktrees.

## Workspaces built on existing projects

Use **Edit workspace** in a project's native menu to select child folders. The plugin connects the corresponding BB projects and groups them under the workspace; the main repository remains in the **main** group. Removing a folder from the workspace does not delete its project or files.

BB retains its native thread rows, menus and actions. Each project initially shows five top-level thread families; **Show more** reveals the next page. Descendants do not consume extra slots. Project limits are independent and reset on collapse. The page size is configurable from 1 to 100.

## Source Control for explicit repositories

Open **New tab → Source Control**. A workspace shows its main Git repository and explicitly connected paths in the active environment. An ordinary or child project shows only its own repository.

Inspect status and diffs, stage or unstage files, create branches, commit and push within the selected repository. Missing, unavailable or out-of-environment paths remain visible with an explanation and no Git mutation controls. The plugin does not discover arbitrary nested repositories.

Returning from a file immediately restores the last successful snapshot and selected repository, then revalidates in the background. Git mutation controls remain unavailable until validation succeeds. Read-only scan concurrency adapts to the host's CPU count and load.

## Compatibility

Requires **BB ≥0.46 and SDK ≥0.6.37**, with the built-in `thread-list`. Replacement sidebar plugins are not automatically compatible. BB owns project and thread collapse persistence and may expand the selected thread's ancestor path. Worktree creation and lifecycle also remain BB-owned.
