import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";
import type { RepositoryStatus, WorkspaceStatus } from "../contract.js";

const environment = {
  id: "env-test",
  projectId: "project-root",
  hostId: "host-test",
  path: "/work/umbrella",
  managed: true,
  isGitRepo: true,
  isWorktree: true,
  workspaceProvisionType: "worktree" as const,
  branchName: "task/native",
  baseBranch: "main",
  defaultBranch: "main",
  mergeBaseBranch: "main",
  name: null,
  status: "ready" as const,
  createdAt: 1,
  updatedAt: 1,
};

function project(id: string) {
  return {
    id,
    name: id,
    kind: "standard" as const,
    gitRemoteUrl: null,
    sources: [{ hostId: "host-test", path: `/ordinary/${id}` }],
    createdAt: 1,
    updatedAt: 1,
  };
}

function repository(
  relativePath: string,
  available = true,
  unavailableReason: RepositoryStatus["unavailableReason"] = null,
): RepositoryStatus {
  return {
    projectId: null,
    relativePath,
    name: relativePath === "." ? "umbrella" : relativePath.split("/").at(-1)!,
    available,
    unavailableReason,
    error: available ? null : "not available in this environment",
    branch: available ? "task/native" : null,
    detached: !available,
    head: available ? "abc1234" : null,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
  };
}

describe("sidebar pagination settings", () => {
  it("accepts a bounded integer page size and rejects invalid settings", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "multi-repo-git" });
    await plugin(bb);
    await harness.behavior.setSettings({ chatsPerPage: 3 });
    for (const chatsPerPage of [0, -1, 1.5, 101]) {
      await expect(harness.behavior.setSettings({ chatsPerPage })).rejects.toThrow();
    }
    await harness.lifecycle.dispose();
  });
});

describe("workspace sidebar order", () => {
  it("updates the thread-list preferences, includes new children, and is idempotent", async () => {
    let order = ["pinned", "project:project-root", "project:ordinary", "threads"];
    const { bb, harness } = createFakePluginHost({
      pluginId: "multi-repo-git",
      sdk: {
        projects: { get: async ({ projectId }: { projectId: string }) => project(projectId) },
        plugins: {
          callRpc: async ({ pluginId, method, input }: { pluginId: string; method: string; input?: unknown }) => {
            expect(pluginId).toBe("thread-list");
            if (method === "listPreferences") return { preferences: { sectionOrder: order } };
            expect(method).toBe("setPreference");
            const update = input as { key: string; value: string[] };
            expect(update.key).toBe("sectionOrder");
            order = update.value;
            return update;
          },
        },
      },
    });
    await plugin(bb);
    await harness.behavior.callRpc("workspace_link_project", {
      parentProjectId: "project-root", childProjectId: "new-child", relativePath: "frontend",
    });
    const relations = await harness.behavior.callRpc("workspace_relations", null);
    expect(relations).toMatchObject({ links: [{ parentProjectId: "project-root", childProjectId: "new-child" }] });
    expect(order).toEqual(["pinned", "project:project-root", "project:new-child", "project:ordinary", "threads"]);
    await harness.behavior.callRpc("workspace_relations", null);
    expect(harness.inspection.sdk.callsTo("plugins.callRpc").filter(
      (call) => (call[0] as { method: string }).method === "setPreference",
    )).toHaveLength(1);
    expect(harness.inspection.sdk.callsTo("system.uiPreferences.set")).toHaveLength(0);
    await harness.lifecycle.dispose();
  });

  it("still returns relations and logs when preference synchronization fails", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "multi-repo-git",
      sdk: {
        projects: { get: async ({ projectId }: { projectId: string }) => project(projectId) },
        plugins: { callRpc: async () => { throw new Error("thread-list unavailable"); } },
      },
    });
    await plugin(bb);
    await harness.behavior.callRpc("workspace_link_project", {
      parentProjectId: "project-root", childProjectId: "child", relativePath: "frontend",
    });
    await expect(harness.behavior.callRpc("workspace_relations", null)).resolves.toMatchObject({
      links: [{ childProjectId: "child" }],
    });
    expect(harness.logEntries.some((entry) => entry.message.includes("thread-list unavailable"))).toBe(true);
    await harness.lifecycle.dispose();
  });
});

describe("server environment routing", () => {
  it("targets only the resolved environment and keeps Git mutations repository-local", async () => {
    const hostCalls: Array<{ method: string; input: unknown; hostId: string }> = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "multi-repo-git",
      sdk: {
        threads: { get: async () => makeThreadResponse({ projectId: "project-root", environmentId: environment.id }) },
        environments: { get: async () => environment },
      },
      experimental_callHostRpc: async (call) => {
        hostCalls.push({ method: call.method, input: call.input, hostId: call.hostId });
        if (call.method === "scan_selected") return { repositories: [repository(".")] };
        if (call.method === "diff") return { patch: "diff", truncated: false };
        if (["stage", "unstage", "commit", "push", "create_branch"].includes(call.method)) {
          return { message: call.method };
        }
        throw new Error(`Unexpected host method ${call.method}`);
      },
    });
    const factory = vi.spyOn(bb.hosts, "experimental_client");
    await plugin(bb);
    const clientCall = vi.spyOn(factory.mock.results[0]!.value, "call");

    await expect(harness.behavior.callRpc("workspace_status", { threadId: "thread-test" }))
      .resolves.toEqual({
        environmentId: environment.id,
        repositories: [{ ...repository("."), projectId: "project-root" }],
        legacyWorktreeSets: [],
      });
    expect(clientCall).toHaveBeenCalledWith("scan_selected",
      { workspaceRoot: environment.path, repositoryPaths: ["."] },
      { hostId: environment.hostId, timeoutMs: 120_000 },
    );
    expect(hostCalls[0]).toEqual({
      method: "scan_selected",
      input: { workspaceRoot: environment.path, repositoryPaths: ["."] },
      hostId: environment.hostId,
    });

    await harness.behavior.callRpc("file_diff", {
      threadId: "thread-test", repositoryPath: ".", filePath: "README.md", staged: true,
    });
    await harness.behavior.callRpc("stage_files", {
      threadId: "thread-test", repositoryPath: ".", paths: ["README.md"],
    });
    await harness.behavior.callRpc("unstage_files", {
      threadId: "thread-test", repositoryPath: ".", paths: ["README.md"],
    });
    await harness.behavior.callRpc("commit", {
      threadId: "thread-test", repositoryPath: ".", message: "safe commit",
    });
    await harness.behavior.callRpc("push", { threadId: "thread-test", repositoryPath: "." });
    await harness.behavior.callRpc("create_branch", {
      threadId: "thread-test", repositoryPath: ".", branch: "feature/test",
    });
    expect(hostCalls.slice(1).map((call) => call.method)).toEqual([
      "diff", "stage", "unstage", "commit", "push", "create_branch",
    ]);
    for (const call of clientCall.mock.calls.slice(1)) {
      expect(call[2]).not.toHaveProperty("timeoutMs");
    }
    expect(hostCalls.slice(1).every((call) =>
      (call.input as { workspaceRoot: string }).workspaceRoot === environment.path &&
      (call.input as { repositoryPath: string }).repositoryPath === ".",
    )).toBe(true);

    await harness.lifecycle.dispose();
  });

  it("projects explicit root members into the environment and reports missing members without fallback", async () => {
    let scannedPaths: string[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "multi-repo-git",
      sdk: {
        projects: {
          get: async ({ projectId }: { projectId: string }) => project(projectId),
        },
        threads: { get: async () => makeThreadResponse({ projectId: "project-root", environmentId: environment.id }) },
        environments: { get: async () => environment },
      },
      experimental_callHostRpc: async (call) => {
        if (call.method === "scan_selected") {
          const input = call.input as { repositoryPaths: string[] };
          scannedPaths = input.repositoryPaths;
          return {
            repositories: input.repositoryPaths.map((path) =>
              path === "packages/missing"
                ? repository(path, false, "missing")
                : repository(path),
            ),
          };
        }
        throw new Error(`Unexpected host method ${call.method}`);
      },
    });
    await plugin(bb);
    await harness.behavior.callRpc("workspace_link_project", {
      parentProjectId: "project-root",
      childProjectId: "project-child",
      relativePath: "packages/child",
    });
    await harness.behavior.callRpc("workspace_link_project", {
      parentProjectId: "project-root",
      childProjectId: "project-missing",
      relativePath: "packages/missing",
    });

    const status = await harness.behavior.callRpc("workspace_status", {
      threadId: "thread-root",
    }) as WorkspaceStatus;
    expect(scannedPaths).toEqual([".", "packages/child", "packages/missing"]);
    expect(status.repositories).toEqual([
      expect.objectContaining({ relativePath: ".", projectId: "project-root", available: true }),
      expect.objectContaining({ relativePath: "packages/child", projectId: "project-child", available: true }),
      expect.objectContaining({
        relativePath: "packages/missing",
        projectId: "project-missing",
        available: false,
        unavailableReason: "missing",
      }),
    ]);
    expect(scannedPaths).not.toContain("/ordinary/project-missing");

    await harness.lifecycle.dispose();
  });

  it("scans only the child environment root for child-project threads", async () => {
    let threadProjectId = "project-root";
    let scannedPaths: string[] = [];
    const childEnvironment = { ...environment, projectId: "project-child", path: "/work/child" };
    const { bb, harness } = createFakePluginHost({
      pluginId: "multi-repo-git",
      sdk: {
        projects: { get: async ({ projectId }: { projectId: string }) => project(projectId) },
        threads: { get: async () => makeThreadResponse({ projectId: threadProjectId, environmentId: environment.id }) },
        environments: { get: async () => childEnvironment },
      },
      experimental_callHostRpc: async (call) => {
        if (call.method === "scan_selected") {
          const input = call.input as { repositoryPaths: string[] };
          scannedPaths = input.repositoryPaths;
          return { repositories: [repository(".")] };
        }
        throw new Error(`Unexpected host method ${call.method}`);
      },
    });
    await plugin(bb);
    await harness.behavior.callRpc("workspace_link_project", {
      parentProjectId: "project-root",
      childProjectId: "project-child",
      relativePath: "packages/child",
    });
    threadProjectId = "project-child";
    const status = await harness.behavior.callRpc("workspace_status", {
      threadId: "thread-child",
    }) as WorkspaceStatus;
    expect(scannedPaths).toEqual(["."]);
    expect(status.repositories).toEqual([
      expect.objectContaining({ relativePath: ".", projectId: "project-child" }),
    ]);

    await harness.lifecycle.dispose();
  });

  it("rejects threads without a workspace", async () => {
    const { bb, harness } = createFakePluginHost({
      sdk: { threads: { get: async () => makeThreadResponse({ environmentId: null }) } },
    });
    await plugin(bb);
    await expect(harness.behavior.callRpc("workspace_status", { threadId: "thread-test" }))
      .rejects.toThrow("no workspace environment");
    await harness.lifecycle.dispose();
  });
});
