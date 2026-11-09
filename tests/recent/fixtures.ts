import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { messageTime, topRecent, type EventRow, type Sdk, type ThreadEntry, type MessageIndex } from "../../lib/recent/data.js";

export const thread = (id: string, overrides: Partial<ThreadEntry> = {}): ThreadEntry => ({
  ...makeThreadResponse({ id, projectId: "proj_synthetic" }),
  activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeGoalCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 },
  queuedWork: "none", pinSortKey: null, hasPendingInteraction: false,
  environmentHostId: null, environmentName: null, environmentBranchName: null,
  environmentPath: null, environmentProviderId: null, environmentIsWorktree: null,
  environmentWorkspaceDisplayKind: "other", ...overrides,
});
export function event(type: string, data: unknown, createdAt: number, seq = createdAt): EventRow {
  return { id: `evt_synthetic_${seq}`, threadId: "thr_synthetic", scope: { kind: "thread" }, seq, createdAt, type, data } as EventRow;
}
export const user = (at: number, seq = at, extra: object = {}) => event("client/turn/requested", {
  initiator: "user", input: [{ type: "text", text: "synthetic", mentions: [] }], ...extra,
}, at, seq);
export const assistant = (at: number, seq = at, extra: object = {}) => event("item/completed", {
  item: { type: "agentMessage", id: "synthetic", text: "synthetic", ...extra },
}, at, seq);
export const tool = (at: number, seq = at) => event("item/completed", {
  item: { type: "toolCall", id: "synthetic", tool: "synthetic", status: "completed" },
}, at, seq);

export function fixture(initial: ThreadEntry[] = [thread("thr_synthetic")]) {
  const listeners = new Map<string, Set<(value: any) => void>>();
  const calls: { method: string; args: any }[] = [];
  let rows = initial;
  const histories = new Map<string, EventRow[]>();
  for (const row of rows) histories.set(row.id, [user(100), assistant(200)]);
  let failure = false;
  let readHook: ((id: string) => Promise<void>) | undefined;
  const sdk: Sdk = {
    plugins: { callRpc: async (args: any) => {
      calls.push({ method: "rpc", args });
      await readHook?.("latest");
      args.signal?.throwIfAborted();
      if (failure) throw new Error("synthetic failure");
      const index = new Map<string, MessageIndex>();
      for (const row of rows.filter(row => row.deletedAt === null && row.archivedAt === null && row.visibility !== "hidden")) {
        const times = (histories.get(row.id) ?? []).flatMap(event => {
          const at = messageTime(event); return at === null ? [] : [at];
        });
        index.set(row.id, { lastMessageAt: times.length ? Math.max(...times) : null, lastSeq: 0 });
      }
      return args.outputSchema.parse({ rows: topRecent(index), queryMs: 0 });
    } },
    subscribe: (args: any) => {
      const set = listeners.get(args.event) ?? new Set();
      set.add(args.callback); listeners.set(args.event, set);
      if (args.event === "realtime:connection") args.callback({ state: "connected", reconnected: false, reconnectDelayMs: null });
      return () => { set.delete(args.callback); };
    },
  };
  return { sdk, calls, histories, listeners,
    setRows(next: ThreadEntry[]) { rows = next; },
    setFailure(next: boolean) { failure = next; },
    setReadHook(next?: (id: string) => Promise<void>) { readHook = next; },
    emit(value: any) { for (const callback of listeners.get("thread:changed") ?? []) callback(value); },
    connection(state: string, reconnected = false) {
      for (const callback of listeners.get("realtime:connection") ?? []) callback({ state, reconnected, reconnectDelayMs: null });
    },
  };
}
