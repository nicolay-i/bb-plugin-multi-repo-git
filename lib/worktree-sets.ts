import type Database from "better-sqlite3";
import type { LegacyWorktreeSet } from "../contract.js";

// These shipped migrations remain at their original indices so existing plugin
// databases can still be opened safely. The upgraded plugin only reads these
// legacy tables; it never inserts, updates, merges, or removes their records.
export const WORKTREE_SET_MIGRATION = `
  CREATE TABLE worktree_sets (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('child', 'workspace')),
    root_project_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    thread_id TEXT UNIQUE,
    environment_id TEXT UNIQUE,
    lifecycle_status TEXT NOT NULL CHECK(lifecycle_status IN (
      'planned', 'materializing', 'partial', 'ready', 'merging',
      'merge_conflict', 'merged', 'removing', 'remove_blocked', 'removed'
    )),
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX worktree_sets_root_created
    ON worktree_sets(root_project_id, created_at DESC);

  CREATE TABLE worktree_set_members (
    id TEXT PRIMARY KEY,
    set_id TEXT NOT NULL REFERENCES worktree_sets(id),
    project_id TEXT,
    repository_key TEXT NOT NULL,
    source_repository_path TEXT NOT NULL,
    workspace_relative_path TEXT NOT NULL,
    parent_member_id TEXT REFERENCES worktree_set_members(id),
    depth INTEGER NOT NULL CHECK(depth >= 0),
    position INTEGER NOT NULL CHECK(position >= 0),
    target_branch TEXT NOT NULL,
    creation_head TEXT NOT NULL,
    task_branch TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    materialization_status TEXT NOT NULL CHECK(materialization_status IN (
      'pending', 'running', 'complete', 'blocked', 'failed', 'skipped'
    )),
    merge_status TEXT NOT NULL CHECK(merge_status IN (
      'pending', 'running', 'complete', 'blocked', 'failed', 'skipped'
    )),
    removal_status TEXT NOT NULL CHECK(removal_status IN (
      'pending', 'running', 'complete', 'blocked', 'failed', 'skipped'
    )),
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(set_id, repository_key),
    UNIQUE(source_repository_path, task_branch),
    UNIQUE(worktree_path)
  );
  CREATE INDEX worktree_set_members_set_position
    ON worktree_set_members(set_id, position);
  CREATE INDEX worktree_set_members_set_depth
    ON worktree_set_members(set_id, depth DESC, position);

  CREATE TABLE worktree_set_steps (
    set_id TEXT NOT NULL REFERENCES worktree_sets(id),
    member_id TEXT NOT NULL REFERENCES worktree_set_members(id),
    phase TEXT NOT NULL CHECK(phase IN ('materialize', 'merge', 'remove')),
    status TEXT NOT NULL CHECK(status IN (
      'pending', 'running', 'complete', 'blocked', 'failed', 'skipped'
    )),
    attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
    message TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(set_id, member_id, phase)
  );
  CREATE INDEX worktree_set_steps_set_phase
    ON worktree_set_steps(set_id, phase, status);
`;

export const WORKTREE_SET_PROJECTS_MIGRATION = `
  CREATE TABLE worktree_set_projects (
    set_id TEXT NOT NULL REFERENCES worktree_sets(id),
    project_id TEXT NOT NULL,
    workspace_relative_path TEXT NOT NULL,
    repository_key TEXT,
    repository_relative_path TEXT,
    tracked INTEGER NOT NULL CHECK(tracked IN (0, 1)),
    PRIMARY KEY(set_id, project_id)
  );
  CREATE INDEX worktree_set_projects_repository
    ON worktree_set_projects(set_id, repository_key);
`;

export const WORKTREE_SET_GITLINKS_MIGRATION = `
  CREATE TABLE worktree_set_gitlinks (
    set_id TEXT NOT NULL REFERENCES worktree_sets(id),
    child_member_id TEXT NOT NULL REFERENCES worktree_set_members(id),
    parent_member_id TEXT NOT NULL REFERENCES worktree_set_members(id),
    path TEXT NOT NULL,
    expected_child_head TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN (
      'pending', 'running', 'complete', 'blocked', 'failed', 'skipped'
    )),
    attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
    commit_head TEXT,
    message TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(set_id, child_member_id)
  );
  CREATE INDEX worktree_set_gitlinks_parent
    ON worktree_set_gitlinks(set_id, parent_member_id, status);
`;

interface LegacySetRow {
  id: string;
  host_id: string;
  lifecycle_status: string;
}

interface LegacyMemberRow {
  set_id: string;
  worktree_path: string;
  task_branch: string;
  materialization_status: string;
  merge_status: string;
  removal_status: string;
}

export function listLegacyWorktreeSets(
  db: Database.Database,
): LegacyWorktreeSet[] {
  const sets = db.prepare(
    `SELECT id, host_id, lifecycle_status
     FROM worktree_sets
     ORDER BY created_at DESC, id
     LIMIT 100`,
  ).all() as LegacySetRow[];
  if (sets.length === 0) return [];

  const readMembers = db.prepare(
    `SELECT set_id, worktree_path, task_branch, materialization_status,
            merge_status, removal_status
     FROM worktree_set_members
     WHERE set_id = ?
     ORDER BY position, id`,
  );
  return sets.map((set) => ({
    id: set.id,
    hostId: set.host_id,
    lifecycleStatus: set.lifecycle_status,
    members: (readMembers.all(set.id) as LegacyMemberRow[]).map((member) => ({
      worktreePath: member.worktree_path,
      taskBranch: member.task_branch,
      materializationStatus: member.materialization_status,
      mergeStatus: member.merge_status,
      removalStatus: member.removal_status,
    })),
  }));
}
