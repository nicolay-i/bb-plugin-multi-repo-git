# Sidebar parity contract

The workspace sidebar must not replace ordinary BB behavior with a reduced
thread list. The reference implementation was audited from BB 0.40.0
(`apps/app/src/components/sidebar/{ProjectList,ProjectRow,ThreadRow}.tsx` and
`components/project/{ProjectActionsMenu,ProjectActionsProvider}.tsx`).

## Activation boundary

- Always render BB's bound `Original` list; workspace mode decorates and orders
  its real project-row DOM nodes rather than reimplementing them.
- With no workspace links, the native list is unchanged.
- The workspace editor entry augments the native project actions menu but does
  not remove or intercept native entries.
- If workspace data cannot load, remove decorations and keep `Original`.

## Project behavior to preserve

- Pinned threads section.
- Project collapse/expand and collapsed activity roll-up.
- Project order and drag-to-reorder (or an explicit equivalent control until
  drag parity is available).
- Sidebar display options: project/machine/manual organization and
  updated/created/alphabetical sort. Workspace grouping applies to project
  organization; the other organizations must delegate to `Original`.
- Project actions:
  - Project settings (including every machine-local source and source actions);
  - Rename;
  - Add local path when available, either directly or through Project settings;
  - Remove with destructive confirmation;
  - Edit workspace (plugin addition).
- New thread in the selected project.
- Missing project-source warning linking to Project settings.
- Desktop context menu and compact/coarse-pointer affordances.

## Thread behavior to preserve

- Native title fallback and unread/working/error/waiting indicators.
- Provider and worktree/environment presentation.
- Parent/child thread trees and collapse state.
- Environment grouping for shared worktrees.
- Manual thread sections.
- Search filtering from the host search box.
- Open, open-in-split, drag-to-split, keyboard next/previous targets.
- Pin/unpin, mark read/unread, rename, archive, and host-owned delete
  confirmation.
- Active/open-in-split visual state.

## Workspace additions

- A root with children gains a collapsible `main` subgroup for the root
  project's threads. Its heading uses the same visual language as a compatible
  native direct-child project heading; `main` remains a UI group, not a Git
  branch.
- Direct child BB projects are rendered as sibling subgroups under that root and
  omitted from the top level.
- Content below `main` and below every direct child group receives one shared
  8px hierarchy inset. Native chat rows and native empty states therefore begin
  one level below their subgroup heading while root and child content retain
  equivalent left/right geometry.
- Collapsing a workspace root hides its complete presented subtree: `main`, root
  chats, child-project rows, and child chats. Expanding restores the previous
  independent `main` and native child-project collapse states.
- Collapsing `main` hides only root chats; collapsing one child project hides
  only that project's chats and does not affect siblings.
- On compatible BB rows, clicking the project title delegates exactly once to
  the native chevron. Project menus, new-thread controls, links, warnings,
  context menus, and DnD pointer handling remain separate native interactions.
- Children remain real BB projects; their project settings, thread actions, and
  environments are unchanged.
- Worktree is a BB-owned environment/thread indicator, never a plugin action or
  separate top-level tree.
- Unlink warns that logical relations are lost and never deletes projects,
  threads, branches, environments, or worktree directories.

## SDK boundary

The implementation and live regression pass target BB 0.40.0 with public
`@get-bb/plugin-sdk` 0.4.21. The plugin deliberately leaves BB's native
new-thread screen and its current-folder/new-worktree placement untouched. The
SDK exposes thread actions and thread-list slots, but no native project-row
renderer, project action hook, project-menu contribution, sidebar organization
state, or project-row `Original` component.
Therefore project grouping/menu parity is preserved with a native-row
decoration strategy:

1. Keep `Original` mounted in every mode.
2. Add only the workspace menu entry through a cleanup-safe content script.
3. Reorder and indent the existing keyed project-row elements, inject the
   system `main` label using a compatible native heading as its visual
   reference, and inset only the native content wrappers; do not clone
   thread/project behavior.
4. Treat the native project chevron and its `aria-expanded` state as the source
   of truth. The bridge only propagates root visibility to decorated siblings
   and owns the independent `main` state.
5. Add title activation only when the narrow BB 0.40 heading/title/chevron
   contract is present; otherwise preserve the untouched native fallback.
6. Reapply decorations after React updates and relevant native state changes,
   coalesce observer work, and restore each plugin-owned visibility and inline
   layout value on unlink, relation failure, and teardown.
7. Prefer a future official project-group/menu contribution point when BB adds
   one; the content-script bridge is deliberately isolated for replacement.

No unpublished BB imports are used. The bridge was retained because the tested
SDK still has no equivalent extension point; unsupported markup or RPC failure
falls back to the untouched native `Original` list.
