import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  arrangeWorkspaceSectionOrder,
  findWorkspaceParent,
  linkWorkspaceProject,
  listWorkspaceLinks,
  normalizeWorkspaceRelativePath,
  unlinkWorkspaceProject,
} from "../lib/workspaces.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE workspace_project_links (
      parent_project_id TEXT NOT NULL,
      child_project_id TEXT PRIMARY KEY,
      relative_path TEXT NOT NULL,
      position INTEGER NOT NULL CHECK(position >= 0),
      created_at INTEGER NOT NULL,
      CHECK(parent_project_id <> child_project_id)
    );
    CREATE INDEX workspace_project_links_parent_position
      ON workspace_project_links(parent_project_id, position);
  `);
});

afterEach(() => db.close());

describe("workspace project links", () => {
  it("keeps workspace children adjacent to their parent for windowed sidebars", () => {
    expect(arrangeWorkspaceSectionOrder(
      ["pinned", "project:root", "project:other", "project:backend", "threads"],
      [
        { parentProjectId: "root", childProjectId: "backend", position: 0 },
        { parentProjectId: "root", childProjectId: "frontend", position: 1 },
      ],
    )).toEqual([
      "pinned",
      "project:root",
      "project:backend",
      "project:frontend",
      "project:other",
      "threads",
    ]);
  });

  it.each([
    ["pinned", "projects", "threads"],
    ["pinned", "projects", "project:root", "project:backend", "threads"],
  ])("replaces the legacy projects aggregate before BB expands it: %j", (...order) => {
    const links = [{ parentProjectId: "root", childProjectId: "backend", position: 0 }];
    const next = arrangeWorkspaceSectionOrder(order, links);
    expect(next).toEqual(["pinned", "project:root", "project:backend", "threads"]);
    expect(arrangeWorkspaceSectionOrder(next, links)).toEqual(next);
  });

  it("preserves the legacy default when no workspace is linked", () => {
    const order = ["pinned", "projects", "threads"];
    expect(arrangeWorkspaceSectionOrder(order, [])).toEqual(order);
  });

  it("normalizes portable child paths", () => {
    expect(normalizeWorkspaceRelativePath("./packages\\storefront/")).toBe(
      "packages/storefront",
    );
    expect(() => normalizeWorkspaceRelativePath("."))
      .toThrow("non-root relative path");
    expect(() => normalizeWorkspaceRelativePath("../outside"))
      .toThrow("non-root relative path");
  });

  it("keeps ordered direct children and unlinks without deleting project state", () => {
    linkWorkspaceProject(db, {
      parentProjectId: "root",
      childProjectId: "backend",
      relativePath: "backend",
      now: 10,
    });
    linkWorkspaceProject(db, {
      parentProjectId: "root",
      childProjectId: "storefront",
      relativePath: "storefront",
      now: 20,
    });

    expect(listWorkspaceLinks(db, "root").map((link) => link.childProjectId))
      .toEqual(["backend", "storefront"]);
    expect(findWorkspaceParent(db, "backend")?.parentProjectId).toBe("root");
    expect(unlinkWorkspaceProject(db, "root", "backend")).toBe(true);
    expect(findWorkspaceParent(db, "backend")).toBeNull();
    expect(listWorkspaceLinks(db, "root")).toHaveLength(1);
  });

  it("allows one direct parent only", () => {
    linkWorkspaceProject(db, {
      parentProjectId: "root-a",
      childProjectId: "backend",
      relativePath: "backend",
    });
    expect(() =>
      linkWorkspaceProject(db, {
        parentProjectId: "root-b",
        childProjectId: "backend",
        relativePath: "backend",
      }),
    ).toThrow("already belongs to another workspace");
  });

  it("enforces the two-level visible workspace model", () => {
    linkWorkspaceProject(db, {
      parentProjectId: "root",
      childProjectId: "backend",
      relativePath: "backend",
    });

    expect(() =>
      linkWorkspaceProject(db, {
        parentProjectId: "backend",
        childProjectId: "nested",
        relativePath: "nested",
      }),
    ).toThrow("child cannot own another workspace");

    expect(() =>
      linkWorkspaceProject(db, {
        parentProjectId: "other",
        childProjectId: "root",
        relativePath: "root",
      }),
    ).toThrow("workspace root cannot be linked");
  });
});
