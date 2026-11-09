import { describe, expect, it } from "vitest";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { workingThreadIds } from "../../lib/recent/work-status";

const row = (id: string, extra: Partial<PluginSidebarThread> = {}) => ({
  id, parentThreadId: null, sourceThreadId: null, originKind: null,
  runtimeStatus: "idle", indicator: "none", isArchived: false, isHidden: false,
  hasPendingInteraction: false,
  activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
  ...extra,
} as PluginSidebarThread);
const collect = (...rows: PluginSidebarThread[]) => workingThreadIds(new Map(rows.map(t => [t.id, t])));

describe("Recent family work", () => {
  it("marks an idle parent and every ancestor of an active grandchild", () => {
    expect(collect(row("root"), row("middle", { parentThreadId: "root" }),
      row("busy", { parentThreadId: "middle", runtimeStatus: "active", indicator: "unread-success" })))
      .toEqual(new Set(["busy", "middle", "root"]));
  });
  it("uses background activity and native work indicators even while runtime is idle", () => {
    const background = row("job", { parentThreadId: "root" }); background.activity.backgroundCommands = 1;
    expect(collect(row("root"), background, row("workflow", { parentThreadId: "root", indicator: "workflow" })))
      .toEqual(new Set(["job", "workflow", "root"]));
  });
  it("does not keep the parent busy once its child finishes", () => {
    const root = row("root"), child = row("child", { parentThreadId: "root", runtimeStatus: "active" });
    expect(collect(root, child).has("root")).toBe(true);
    expect(collect(root, { ...child, runtimeStatus: "idle" })).toEqual(new Set());
  });
  it("ignores archived work and does not mark unrelated families", () => {
    expect(collect(row("root"), row("other"), row("old", { parentThreadId: "root", runtimeStatus: "active", isArchived: true }),
      row("busy", { parentThreadId: "other", runtimeStatus: "active" }))).toEqual(new Set(["busy", "other"]));
  });
  it("does not interpret a child waiting for user input as generation", () => {
    expect(collect(row("root"), row("question", { parentThreadId: "root", runtimeStatus: "active",
      hasPendingInteraction: true, indicator: "waiting-for-input" }))).toEqual(new Set());
  });
  it("includes hidden sidechat work at its source but not independent visible forks", () => {
    expect(collect(row("root"), row("other"), row("sidechat", { isHidden: true, originKind: "fork",
      sourceThreadId: "root", runtimeStatus: "active" }), row("fork", { originKind: "fork", sourceThreadId: "other", runtimeStatus: "active" })))
      .toEqual(new Set(["sidechat", "fork", "root"]));
  });
  it("terminates on cycles and missing parents", () => {
    expect(collect(row("a", { parentThreadId: "b", runtimeStatus: "active" }), row("b", { parentThreadId: "a" }),
      row("orphan", { parentThreadId: "missing", runtimeStatus: "active" }))).toEqual(new Set(["a", "orphan", "b"]));
  });
});
