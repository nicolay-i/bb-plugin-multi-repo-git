# Multi Repo Git architecture

## Product model

Multi Repo Git adds an explicit workspace layer over real BB projects.
Filesystem nesting never groups projects automatically. **Edit workspace**
links direct child projects selected from folders beneath a root project.

```text
root project
├── main                 # root project's threads
├── child project A
└── child project B
```

`main` is a UI label, not a Git branch. A child has at most one parent, a child
cannot own children, and a root cannot also be a child. Unlinking removes only
the relationship; BB projects and all BB/Git/filesystem state remain intact.

## Execution boundaries

- The server entry owns durable workspace relationships, BB context resolution,
  typed RPC, and realtime invalidation.
- The host entry owns canonical path checks and argument-array Git processes on
  the machine holding the active environment.
- The app entry owns Source Control and workspace presentation.

The server resolves the thread's current environment and passes its workspace
path to the host. The host inspects only explicitly requested relative paths and
returns one result for each request. It does not recursively discover nested
repositories or submodules.

## Active-environment repository projection

An ordinary or child project exposes only `.` from its active environment. A
workspace root exposes `.` plus the current explicit member paths. Every member
is resolved inside that same environment; the plugin does not use an ordinary
project source as a fallback and does not clone missing content.

Available paths must be contained repository roots. A missing path,
non-repository directory, escaping path, or inspection failure remains visible
as an unavailable member with a stable reason. Unavailable members have no Git
mutation controls. Available repositories support repository-local status,
diff, stage, unstage, branch creation, commit, and push.

## Native worktree ownership

BB's native **New thread** screen is the sole worktree creation surface. The
user selects project, machine, source, and current-folder/new-worktree placement
there. BB owns environment creation, worktree paths, branches, archive behavior,
and cleanup. This plugin has no worktree creation, merge, removal, retry, or
archive hook and does not intercept BB's lifecycle.

A BB-created workspace-root worktree is therefore just another active
environment. Source Control applies the same explicit relative member paths to
that environment and reports members not present there as unavailable.

Target projects provision extra repositories and local inputs through declared
submodules, `.bb-env-setup.sh`, and/or `.worktreeinclude`. The plugin does not
run those mechanisms itself. Durable task work must be committed and pushed or
otherwise integrated before the final environment thread is archived or
deleted, after which BB may apply its native cleanup policy.

## Sidebar presentation and collapse

The sidebar always keeps BB's real project and thread rows. BB 0.40 and public
`@get-bb/plugin-sdk` 0.4.21 do not expose project grouping or project-menu
contribution hooks, so an isolated bridge decorates compatible native rows and
adds **Edit workspace**. Unsupported markup or RPC failure leaves the native
list untouched.

A root's native collapse state controls the presented subtree. `main` has an
independent per-client collapse state, while each child retains BB's native
state. The injected `main` heading uses a compatible native project heading as
its visual reference. Its root-chat content and each child group's native
content receive the same additional 8px hierarchy inset, so chat rows and
empty states visibly belong to their subgroup without replacing native rows.
The bridge records and restores every inline layout value it owns on rerender,
unlink, relation failure, and disposal. Menus, new-thread controls, links,
warnings, context menus, and drag handling remain native.

## Persistence and legacy data

Current plugin-owned persistence is limited to `workspace_project_links`.
Historical additive migrations for worktree-set tables remain in their original
order so existing databases continue to open safely. Those tables are queried
only for a read-only legacy inventory. No current RPC or UI action inserts,
updates, deletes, merges, retries, or removes a legacy set or filesystem path.

The inventory is recovery information, not proof that BB owns the historical
paths. Users must inspect and recover or clean legacy Git state manually.

## Safety invariants

- every Git mutation names one selected available repository;
- canonical paths remain inside the active environment;
- file arguments use literal Git pathspecs;
- detached HEAD blocks commit and push until explicit branch creation;
- no reset, discard, checkout-overwrite, force push, hidden pull/merge,
  automatic gitlink commit, cloning, or worktree lifecycle operation exists.
