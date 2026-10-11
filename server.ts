import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, rpcContract } from "./contract.js";
import {
  arrangeWorkspaceSectionOrder,
  linkWorkspaceProject,
  listAllWorkspaceLinks,
  listWorkspaceLinks,
  normalizeWorkspaceRelativePath,
  unlinkWorkspaceProject,
} from "./lib/workspaces.js";
import {
  listLegacyWorktreeSets,
  WORKTREE_SET_GITLINKS_MIGRATION,
  WORKTREE_SET_MIGRATION,
  WORKTREE_SET_PROJECTS_MIGRATION,
} from "./lib/worktree-sets.js";

export { rpcContract } from "./contract.js";
export type {
  DiffResult,
  FileChange,
  LegacyWorktreeSet,
  RepositoryStatus,
  WorkspaceChild,
  WorkspaceConfig,
  WorkspaceFolderBrowser,
  WorkspaceStatus,
} from "./contract.js";

interface WorkspaceTarget {
  environmentId: string;
  projectId: string;
  hostId: string;
  workspaceRoot: string;
}

export default function plugin(bb: BbPluginApi) {
  bb.settings.define({
    chatsPerPage: {
      type: "number",
      label: "Threads per page",
      description: "Initial limit and number of thread families revealed by Show more. Collapsing a group resets its limit.",
      default: 5,
      experimental_schema: z.number().int().min(1).max(100),
    },
  });
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE workspace_project_links (
      parent_project_id TEXT NOT NULL,
      child_project_id TEXT PRIMARY KEY,
      relative_path TEXT NOT NULL,
      position INTEGER NOT NULL CHECK(position >= 0),
      created_at INTEGER NOT NULL,
      CHECK(parent_project_id <> child_project_id)
    );
    CREATE INDEX workspace_project_links_parent_position
      ON workspace_project_links(parent_project_id, position);`,
    WORKTREE_SET_MIGRATION,
    WORKTREE_SET_PROJECTS_MIGRATION,
    WORKTREE_SET_GITLINKS_MIGRATION,
  ]);

  async function syncWorkspaceSectionOrder() {
    const links = listAllWorkspaceLinks(db);
    if (links.length === 0) return;
    // The built-in thread-list plugin owns these preferences now. Core's
    // sidebar.* preferences are only a one-time migration source.
    const response = await bb.sdk.plugins.callRpc({
      pluginId: "thread-list",
      method: "listPreferences",
      input: null,
      outputSchema: z.object({
        preferences: z.object({ sectionOrder: z.array(z.string()) }),
      }),
    });
    const current = response.preferences.sectionOrder;
    const next = arrangeWorkspaceSectionOrder(current, links);
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    await bb.sdk.plugins.callRpc({
      pluginId: "thread-list",
      method: "setPreference",
      input: { key: "sectionOrder", value: next },
      outputSchema: z.object({ key: z.literal("sectionOrder"), value: z.array(z.string()) }),
    });
  }

  async function readWorkspaceConfig(rootProjectId: string) {
    await bb.sdk.projects.get({ projectId: rootProjectId });
    const children = await Promise.all(
      listWorkspaceLinks(db, rootProjectId).map(async (link) => {
        try {
          const project = await bb.sdk.projects.get({ projectId: link.childProjectId });
          return {
            projectId: link.childProjectId,
            name: project.name,
            relativePath: link.relativePath,
            position: link.position,
            available: true,
          };
        } catch {
          return {
            projectId: link.childProjectId,
            name: null,
            relativePath: link.relativePath,
            position: link.position,
            available: false,
          };
        }
      }),
    );
    return { rootProjectId, enabled: children.length > 0, children };
  }

  async function readWorkspaceFolderBrowser(projectId: string, relativePath: string) {
    const project = await bb.sdk.projects.get({ projectId });
    const connectedPaths = new Set(
      listWorkspaceLinks(db, projectId).map((link) => link.relativePath),
    );
    for (const source of project.sources) {
      try {
        const listing = await host.call(
          "list_child_directories",
          { rootPath: source.path, relativePath },
          { hostId: source.hostId },
        );
        return {
          projectId,
          currentPath: listing.currentPath,
          parentPath: listing.parentPath,
          folders: listing.folders.map((folder) => ({
            ...folder,
            connected: connectedPaths.has(folder.relativePath),
          })),
        };
      } catch {
        // Try this project on another configured machine source.
      }
    }
    throw new Error("Project folders are unavailable on every configured machine.");
  }

  async function linkExistingProject(
    parentProjectId: string,
    childProjectId: string,
  ): Promise<void> {
    const [parent, child] = await Promise.all([
      bb.sdk.projects.get({ projectId: parentProjectId }),
      bb.sdk.projects.get({ projectId: childProjectId }),
    ]);
    for (const parentSource of parent.sources) {
      for (const childSource of child.sources) {
        if (parentSource.hostId !== childSource.hostId) continue;
        try {
          const result = await host.call(
            "relative_child_path",
            { rootPath: parentSource.path, childPath: childSource.path },
            { hostId: parentSource.hostId },
          );
          if (result.relativePath !== null) {
            linkWorkspaceProject(db, {
              parentProjectId,
              childProjectId,
              relativePath: result.relativePath,
            });
            return;
          }
        } catch {
          // Another source pair may be available on a connected host.
        }
      }
    }
    throw new Error(
      "The child project must have a source folder inside the parent project on the same machine.",
    );
  }

  async function addWorkspaceFolder(
    parentProjectId: string,
    relativePath: string,
  ): Promise<void> {
    const parent = await bb.sdk.projects.get({ projectId: parentProjectId });
    const resolvedSources: Array<{ hostId: string; path: string; name: string }> = [];
    for (const source of parent.sources) {
      try {
        const resolved = await host.call(
          "resolve_child_directory",
          { rootPath: source.path, relativePath },
          { hostId: source.hostId },
        );
        if (resolved.absolutePath !== null && resolved.name !== null) {
          resolvedSources.push({
            hostId: source.hostId,
            path: resolved.absolutePath,
            name: resolved.name,
          });
        }
      } catch {
        // Offline sources do not prevent adding an available source.
      }
    }
    if (resolvedSources.length === 0) {
      throw new Error("The folder was not found inside an available source of this project.");
    }

    const projects = await bb.sdk.projects.list();
    const normalized = (value: string) =>
      value.replaceAll("\\", "/").replace(/\/$/, "").toLocaleLowerCase();
    const existing = projects.find((project) =>
      project.sources.some((source) =>
        resolvedSources.some((resolved) =>
          resolved.hostId === source.hostId &&
          normalized(resolved.path) === normalized(source.path),
        ),
      ),
    );

    let childProjectId: string;
    if (existing) {
      childProjectId = existing.id;
    } else {
      const [primary, ...additional] = resolvedSources;
      if (!primary) throw new Error("The folder source became unavailable.");
      const created = await bb.sdk.projects.create({
        name: primary.name,
        source: { type: "local_path", hostId: primary.hostId, path: primary.path },
      });
      childProjectId = created.id;
      for (const source of additional) {
        await bb.sdk.projects.sources.add({
          projectId: created.id,
          type: "local_path",
          hostId: source.hostId,
          path: source.path,
        });
      }
    }
    linkWorkspaceProject(db, { parentProjectId, childProjectId, relativePath });
  }

  async function resolveWorkspace(threadId: string): Promise<WorkspaceTarget> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.environmentId === null) {
      throw new Error("This thread has no workspace environment.");
    }
    const environment = await bb.sdk.environments.get({
      environmentId: thread.environmentId,
    });
    if (environment.status !== "ready" || environment.path === null) {
      throw new Error("The thread workspace is not ready.");
    }
    return {
      environmentId: environment.id,
      projectId: thread.projectId,
      hostId: environment.hostId,
      workspaceRoot: environment.path,
    };
  }

  bb.rpc.register(rpcContract, {
    workspace_relations: async () => {
      await syncWorkspaceSectionOrder().catch((error: unknown) => {
        bb.log.warn(`Could not synchronize workspace sidebar order: ${error instanceof Error ? error.message : String(error)}`);
      });
      return { links: listAllWorkspaceLinks(db).map((link) => ({
        parentProjectId: link.parentProjectId,
        childProjectId: link.childProjectId,
        relativePath: link.relativePath,
        position: link.position,
      })),
      };
    },
    workspace_config: async ({ projectId }) => readWorkspaceConfig(projectId),
    workspace_folder_browser: async ({ projectId, relativePath }) =>
      readWorkspaceFolderBrowser(projectId, relativePath),
    workspace_link_project: async ({ parentProjectId, childProjectId, relativePath }) => {
      await Promise.all([
        bb.sdk.projects.get({ projectId: parentProjectId }),
        bb.sdk.projects.get({ projectId: childProjectId }),
      ]);
      linkWorkspaceProject(db, { parentProjectId, childProjectId, relativePath });
      const config = await readWorkspaceConfig(parentProjectId);
      bb.realtime.publish("workspaces-changed", { parentProjectId });
      return config;
    },
    workspace_add_folder: async ({ parentProjectId, relativePath }) => {
      await addWorkspaceFolder(parentProjectId, relativePath.trim());
      const config = await readWorkspaceConfig(parentProjectId);
      bb.realtime.publish("workspaces-changed", { parentProjectId });
      return config;
    },
    workspace_add_folders: async ({ parentProjectId, relativePaths }) => {
      for (const relativePath of [...new Set(relativePaths)]) {
        await addWorkspaceFolder(parentProjectId, relativePath);
      }
      const config = await readWorkspaceConfig(parentProjectId);
      bb.realtime.publish("workspaces-changed", { parentProjectId });
      return config;
    },
    workspace_update_folders: async ({ parentProjectId, relativePaths }) => {
      const desiredPaths = [...new Set(relativePaths.map(normalizeWorkspaceRelativePath))];
      const existingPaths = new Set(
        listWorkspaceLinks(db, parentProjectId).map((link) => link.relativePath),
      );
      for (const relativePath of desiredPaths) {
        if (!existingPaths.has(relativePath)) {
          await addWorkspaceFolder(parentProjectId, relativePath);
        }
      }
      const desired = new Set(desiredPaths);
      for (const link of listWorkspaceLinks(db, parentProjectId)) {
        if (!desired.has(link.relativePath)) {
          unlinkWorkspaceProject(db, parentProjectId, link.childProjectId);
        }
      }
      const config = await readWorkspaceConfig(parentProjectId);
      bb.realtime.publish("workspaces-changed", { parentProjectId });
      return config;
    },
    workspace_link_existing_project: async ({ parentProjectId, childProjectId }) => {
      await linkExistingProject(parentProjectId, childProjectId);
      const config = await readWorkspaceConfig(parentProjectId);
      bb.realtime.publish("workspaces-changed", { parentProjectId });
      return config;
    },
    workspace_unlink_project: async ({ parentProjectId, childProjectId }) => {
      unlinkWorkspaceProject(db, parentProjectId, childProjectId);
      const config = await readWorkspaceConfig(parentProjectId);
      bb.realtime.publish("workspaces-changed", { parentProjectId });
      return config;
    },
    workspace_status: async ({ threadId }) => {
      const target = await resolveWorkspace(threadId);
      const links = listAllWorkspaceLinks(db);
      const isChild = links.some((link) => link.childProjectId === target.projectId);
      const members = isChild
        ? [{ projectId: target.projectId, relativePath: "." }]
        : [
            { projectId: target.projectId, relativePath: "." },
            ...listWorkspaceLinks(db, target.projectId).map((link) => ({
              projectId: link.childProjectId,
              relativePath: link.relativePath,
            })),
          ];
      const result = await host.call(
        "scan_selected",
        {
          workspaceRoot: target.workspaceRoot,
          repositoryPaths: members.map((member) => member.relativePath),
        },
        // This read-only batch can scan multiple repositories sequentially on a busy host.
        // Keep it bounded, but do not apply the default 30-second single-call budget.
        { hostId: target.hostId, timeoutMs: 120_000 },
      );
      const projectByPath = new Map(
        members.map((member) => [member.relativePath.replaceAll("\\", "/"), member.projectId]),
      );
      return {
        environmentId: target.environmentId,
        repositories: result.repositories.map((repository) => ({
          ...repository,
          projectId: projectByPath.get(repository.relativePath.replaceAll("\\", "/")) ?? null,
        })),
        legacyWorktreeSets: listLegacyWorktreeSets(db),
      };
    },
    file_diff: async ({ threadId, repositoryPath, filePath, staged }) => {
      const target = await resolveWorkspace(threadId);
      return host.call(
        "diff",
        { workspaceRoot: target.workspaceRoot, repositoryPath, filePath, staged },
        { hostId: target.hostId },
      );
    },
    stage_files: async ({ threadId, repositoryPath, paths }) => {
      const target = await resolveWorkspace(threadId);
      return host.call(
        "stage",
        { workspaceRoot: target.workspaceRoot, repositoryPath, paths },
        { hostId: target.hostId },
      );
    },
    unstage_files: async ({ threadId, repositoryPath, paths }) => {
      const target = await resolveWorkspace(threadId);
      return host.call(
        "unstage",
        { workspaceRoot: target.workspaceRoot, repositoryPath, paths },
        { hostId: target.hostId },
      );
    },
    commit: async ({ threadId, repositoryPath, message }) => {
      const target = await resolveWorkspace(threadId);
      return host.call(
        "commit",
        { workspaceRoot: target.workspaceRoot, repositoryPath, message },
        { hostId: target.hostId },
      );
    },
    push: async ({ threadId, repositoryPath }) => {
      const target = await resolveWorkspace(threadId);
      return host.call(
        "push",
        { workspaceRoot: target.workspaceRoot, repositoryPath },
        { hostId: target.hostId },
      );
    },
    create_branch: async ({ threadId, repositoryPath, branch }) => {
      const target = await resolveWorkspace(threadId);
      return host.call(
        "create_branch",
        { workspaceRoot: target.workspaceRoot, repositoryPath, branch },
        { hostId: target.hostId },
      );
    },
  });

  bb.log.info("Multi Repo Git loaded");
}
