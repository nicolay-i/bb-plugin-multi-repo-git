import type BetterSqlite3 from "better-sqlite3";

export interface WorkspaceLink {
  parentProjectId: string;
  childProjectId: string;
  relativePath: string;
  position: number;
  createdAt: number;
}

export function arrangeWorkspaceSectionOrder(
  sectionOrder: readonly string[],
  links: readonly Pick<WorkspaceLink, "parentProjectId" | "childProjectId" | "position">[],
): string[] {
  const linksByParent = new Map<string, typeof links[number][]>();
  const childKeys = new Set<string>();
  for (const link of links) {
    const current = linksByParent.get(link.parentProjectId) ?? [];
    current.push(link);
    linksByParent.set(link.parentProjectId, current);
    childKeys.add(`project:${link.childProjectId}`);
  }
  for (const children of linksByParent.values()) {
    children.sort((left, right) => left.position - right.position);
  }

  // BB expands the legacy aggregate before explicit IDs, defeating workspace order.
  const withoutChildren = sectionOrder.filter(
    (key) => !childKeys.has(key) && (key !== "projects" || links.length === 0),
  );
  const result: string[] = [];
  const insertedParents = new Set<string>();
  for (const key of withoutChildren) {
    result.push(key);
    if (!key.startsWith("project:")) continue;
    const parentProjectId = key.slice("project:".length);
    const children = linksByParent.get(parentProjectId);
    if (!children) continue;
    insertedParents.add(parentProjectId);
    result.push(...children.map((link) => `project:${link.childProjectId}`));
  }

  const threadsIndex = result.indexOf("threads");
  const insertionIndex = threadsIndex === -1 ? result.length : threadsIndex;
  const missing: string[] = [];
  for (const [parentProjectId, children] of linksByParent) {
    if (insertedParents.has(parentProjectId)) continue;
    missing.push(
      `project:${parentProjectId}`,
      ...children.map((link) => `project:${link.childProjectId}`),
    );
  }
  result.splice(insertionIndex, 0, ...missing);
  return [...new Set(result)];
}

interface WorkspaceLinkRow {
  parent_project_id: string;
  child_project_id: string;
  relative_path: string;
  position: number;
  created_at: number;
}

const SELECT_LINKS = `
  SELECT parent_project_id, child_project_id, relative_path, position, created_at
  FROM workspace_project_links
`;

function fromRow(row: WorkspaceLinkRow): WorkspaceLink {
  return {
    parentProjectId: row.parent_project_id,
    childProjectId: row.child_project_id,
    relativePath: row.relative_path,
    position: row.position,
    createdAt: row.created_at,
  };
}

export function normalizeWorkspaceRelativePath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (
    normalized === "" ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.includes("\0") ||
    normalized.startsWith("/")
  ) {
    throw new Error("Workspace child path must be a non-root relative path.");
  }
  return normalized;
}

export function listAllWorkspaceLinks(
  db: BetterSqlite3.Database,
): WorkspaceLink[] {
  const rows = db
    .prepare(
      `${SELECT_LINKS}
       ORDER BY parent_project_id ASC, position ASC, created_at ASC, child_project_id ASC`,
    )
    .all() as WorkspaceLinkRow[];
  return rows.map(fromRow);
}

export function listWorkspaceLinks(
  db: BetterSqlite3.Database,
  parentProjectId: string,
): WorkspaceLink[] {
  const rows = db
    .prepare(
      `${SELECT_LINKS}
       WHERE parent_project_id = ?
       ORDER BY position ASC, created_at ASC, child_project_id ASC`,
    )
    .all(parentProjectId) as WorkspaceLinkRow[];
  return rows.map(fromRow);
}

export function findWorkspaceParent(
  db: BetterSqlite3.Database,
  childProjectId: string,
): WorkspaceLink | null {
  const row = db
    .prepare(`${SELECT_LINKS} WHERE child_project_id = ?`)
    .get(childProjectId) as WorkspaceLinkRow | undefined;
  return row === undefined ? null : fromRow(row);
}

export function linkWorkspaceProject(
  db: BetterSqlite3.Database,
  input: {
    parentProjectId: string;
    childProjectId: string;
    relativePath: string;
    now?: number;
  },
): WorkspaceLink {
  if (input.parentProjectId === input.childProjectId) {
    throw new Error("A project cannot be its own workspace child.");
  }
  const relativePath = normalizeWorkspaceRelativePath(input.relativePath);

  const transaction = db.transaction(() => {
    const currentParent = findWorkspaceParent(db, input.childProjectId);
    if (
      currentParent !== null &&
      currentParent.parentProjectId !== input.parentProjectId
    ) {
      throw new Error("This project already belongs to another workspace.");
    }
    if (findWorkspaceParent(db, input.parentProjectId) !== null) {
      throw new Error("A workspace child cannot own another workspace.");
    }
    const childOwnsWorkspace = db
      .prepare(
        "SELECT 1 FROM workspace_project_links WHERE parent_project_id = ? LIMIT 1",
      )
      .get(input.childProjectId);
    if (childOwnsWorkspace !== undefined) {
      throw new Error("A workspace root cannot be linked as a child project.");
    }

    if (currentParent !== null) {
      db.prepare(
        `UPDATE workspace_project_links
         SET relative_path = ?
         WHERE child_project_id = ?`,
      ).run(relativePath, input.childProjectId);
      return findWorkspaceParent(db, input.childProjectId)!;
    }

    const positionRow = db
      .prepare(
        `SELECT COALESCE(MAX(position), -1) + 1 AS position
         FROM workspace_project_links
         WHERE parent_project_id = ?`,
      )
      .get(input.parentProjectId) as { position: number };
    const createdAt = input.now ?? Date.now();
    db.prepare(
      `INSERT INTO workspace_project_links
        (parent_project_id, child_project_id, relative_path, position, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      input.parentProjectId,
      input.childProjectId,
      relativePath,
      positionRow.position,
      createdAt,
    );
    return findWorkspaceParent(db, input.childProjectId)!;
  });

  return transaction();
}

export function unlinkWorkspaceProject(
  db: BetterSqlite3.Database,
  parentProjectId: string,
  childProjectId: string,
): boolean {
  const result = db
    .prepare(
      `DELETE FROM workspace_project_links
       WHERE parent_project_id = ? AND child_project_id = ?`,
    )
    .run(parentProjectId, childProjectId);
  return result.changes > 0;
}
