import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  listLegacyWorktreeSets,
  WORKTREE_SET_GITLINKS_MIGRATION,
  WORKTREE_SET_MIGRATION,
  WORKTREE_SET_PROJECTS_MIGRATION,
} from "../lib/worktree-sets.js";

const databases: Database.Database[] = [];

function legacyDatabase(): Database.Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(WORKTREE_SET_MIGRATION);
  db.exec(WORKTREE_SET_PROJECTS_MIGRATION);
  db.exec(WORKTREE_SET_GITLINKS_MIGRATION);
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("read-only legacy worktree inventory", () => {
  it("returns an empty inventory without changing the legacy schema", () => {
    const db = legacyDatabase();
    const tablesBefore = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all();
    expect(listLegacyWorktreeSets(db)).toEqual([]);
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all()).toEqual(tablesBefore);
    expect(db.prepare("SELECT total_changes() AS count").get()).toEqual({ count: 0 });
  });

  it("reports paths and branches without updating or deleting legacy rows", () => {
    const db = legacyDatabase();
    db.prepare(
      `INSERT INTO worktree_sets (
        id, kind, root_project_id, host_id, thread_id, environment_id,
        lifecycle_status, last_error, created_at, updated_at
      ) VALUES (?, 'workspace', ?, ?, ?, ?, 'partial', ?, 1, 2)`,
    ).run(
      "set-legacy",
      "project-root",
      "host-legacy",
      "thread-legacy",
      "environment-legacy",
      "child failed",
    );
    db.prepare(
      `INSERT INTO worktree_set_members (
        id, set_id, project_id, repository_key, source_repository_path,
        workspace_relative_path, parent_member_id, depth, position,
        target_branch, creation_head, task_branch, worktree_path,
        materialization_status, merge_status, removal_status, last_error,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, 1, 2)`,
    ).run(
      "member-legacy",
      "set-legacy",
      "project-root",
      "/ordinary/root",
      "/ordinary/root",
      ".",
      "main",
      "a".repeat(40),
      "task/legacy",
      "/legacy/worktrees/root",
      "failed",
      "pending",
      "pending",
      "child failed",
    );
    const rowsBefore = db.prepare("SELECT * FROM worktree_sets").all();
    const membersBefore = db.prepare("SELECT * FROM worktree_set_members").all();
    const changesBefore = (db.prepare("SELECT total_changes() AS count").get() as { count: number }).count;

    expect(listLegacyWorktreeSets(db)).toEqual([{
      id: "set-legacy",
      hostId: "host-legacy",
      lifecycleStatus: "partial",
      members: [{
        worktreePath: "/legacy/worktrees/root",
        taskBranch: "task/legacy",
        materializationStatus: "failed",
        mergeStatus: "pending",
        removalStatus: "pending",
      }],
    }]);
    expect(db.prepare("SELECT * FROM worktree_sets").all()).toEqual(rowsBefore);
    expect(db.prepare("SELECT * FROM worktree_set_members").all()).toEqual(membersBefore);
    expect(db.prepare("SELECT total_changes() AS count").get()).toEqual({ count: changesBefore });
  });
});
