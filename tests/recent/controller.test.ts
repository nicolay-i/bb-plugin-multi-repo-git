import { afterEach, describe, expect, it, vi } from "vitest";
import { RecentController, type RecentState } from "../../lib/recent/recent-controller.js";
import { assistant, fixture, thread, user } from "./fixtures";

const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });
const wait = (fn: () => void) => vi.waitFor(fn, { timeout: 3500 });
async function setup(f = fixture()) {
  const states: RecentState[] = [];
  const c = new RecentController(f.sdk, state => states.push(state));
  disposers.push(() => c.dispose()); c.start();
  await wait(() => expect(states.at(-1)?.status).toBe("ready"));
  return { f, c, states };
}
const changed = (id = "thr_synthetic", changes = ["events-appended"], eventTypes = ["item/completed"]) =>
  ({ id, changes, metadata: { eventTypes } });

describe("RPC актуализация и жизненный цикл", () => {
  it("один metadata RPC; frontend никогда не читает истории", async () => {
    const { f, states } = await setup();
    expect(states.at(-1)).toEqual({ status: "ready", rows: [{ threadId: "thr_synthetic", lastMessageAt: 200 }] });
    expect(f.calls.map(call => call.method)).toEqual(["rpc"]);
    expect(f.calls[0]!.args).toMatchObject({ pluginId: "multi-repo-git", method: "recent_latest", input: {} });
    expect(JSON.stringify(states)).not.toContain('"text"');
  });
  it("объединяет20инвалидаций в один RPC", async () => {
    const { f, states } = await setup(); f.calls.length = 0;
    f.histories.get("thr_synthetic")!.push(assistant(300, 300));
    for (let i = 0; i < 20; i++) f.emit(changed());
    await wait(() => expect(states.at(-1)?.rows[0]?.lastMessageAt).toBe(300));
    expect(f.calls).toHaveLength(1);
  });
  it("metadata rename/read/status и streaming delta не запускают SQL и не меняют дату", async () => {
    const { f, states } = await setup(); f.calls.length = 0;
    vi.useFakeTimers();
    try {
      // Advance beyond the coalescing timer: an immediate assertion could miss an unwanted scheduled SQL call.
      for (const type of ["item/agentMessage/delta", "item/commandExecution/outputDelta", "item/fileChange/outputDelta",
        "item/reasoning/summaryTextDelta", "item/reasoning/textDelta", "item/plan/delta", "item/started"])
        for (let n = 0; n < 1000; n++) f.emit(changed("thr_synthetic", ["events-appended"], [type]));
      for (const kind of ["title-changed", "read-state-changed", "status-changed", "pin-state-changed"])
        f.emit(changed("thr_synthetic", [kind], []));
      await vi.advanceTimersByTimeAsync(60000);
      expect(f.calls).toHaveLength(0); expect(states.at(-1)?.rows[0]?.lastMessageAt).toBe(200);
    } finally { vi.useRealTimers(); }
  });
  it("history-rewritten повторяет точную SQL выборку без старого seq/максимума", async () => {
    const { f, states } = await setup(); f.calls.length = 0;
    f.histories.set("thr_synthetic", [user(900, 1)]); f.emit(changed("thr_synthetic", ["history-rewritten"], []));
    await wait(() => expect(states.at(-1)?.rows[0]?.lastMessageAt).toBe(900));
    expect(f.calls).toHaveLength(1); expect(f.calls[0]!.args.afterSeq).toBeUndefined();
  });
  it.each([["user", user], ["assistant", assistant]] as const)("replacement %s поднимает чат по дате BB", async (_role, make) => {
    const f = fixture([thread("thr_synthetic"), thread("thr_second")]);
    f.histories.set("thr_second", [assistant(500, 3)]); const { states } = await setup(f);
    expect(states.at(-1)?.rows[0]?.threadId).toBe("thr_second");
    f.histories.set("thr_synthetic", [make(900, 1)]); f.emit(changed("thr_synthetic", ["history-rewritten"], []));
    await wait(() => expect(states.at(-1)?.rows).toEqual([{ threadId: "thr_synthetic", lastMessageAt: 900 }, { threadId: "thr_second", lastMessageAt: 500 }]));
  });
  it("reconnect сверяет пропущенные edit/новые треды одним RPC", async () => {
    const { f, states } = await setup(); f.connection("disconnected"); expect(states.at(-1)?.status).toBe("error");
    f.histories.set("thr_synthetic", [user(900, 1)]); f.setRows([thread("thr_synthetic"), thread("thr_new")]);
    f.histories.set("thr_new", [assistant(1000, 1)]); f.calls.length = 0; f.connection("connected", true);
    await wait(() => expect(states.at(-1)).toEqual({ status: "ready", rows: [{ threadId: "thr_new", lastMessageAt: 1000 }, { threadId: "thr_synthetic", lastMessageAt: 900 }] }));
    expect(f.calls).toHaveLength(1);
  });
  it("удаление проекта сверяет доступность, metadata проекта не перечитывает SQL", async () => {
    const { f, states } = await setup(); f.calls.length = 0;
    for (const callback of f.listeners.get("project:changed") ?? []) callback({ changes: ["project-updated"] });
    expect(f.calls).toHaveLength(0); f.setRows([]);
    for (const callback of f.listeners.get("project:changed") ?? []) callback({ changes: ["project-deleted"] });
    await wait(() => expect(states.at(-1)).toEqual({ status: "ready", rows: [] }));
  });
  it("RPC error не становится пустой/старой выдачей; retry восстанавливает", async () => {
    const { f, c, states } = await setup(); f.setFailure(true); c.retry();
    await wait(() => expect(states.at(-1)?.status).toBe("error")); expect(states.at(-1)?.rows).toEqual([]);
    f.setFailure(false); c.retry(); await wait(() => expect(states.at(-1)?.status).toBe("ready"));
  });
  it("keeps the snapshot during refresh, then replaces it without loading flicker", async () => {
    const { f, c, states } = await setup(); let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.setReadHook(() => gate); const start = states.length;
    c.retry();
    expect(states.at(-1)).toEqual({ status: "refreshing", rows: [{ threadId: "thr_synthetic", lastMessageAt: 200 }] });
    f.histories.get("thr_synthetic")!.push(assistant(900));
    release(); await wait(() => expect(states.at(-1)).toEqual({ status: "ready", rows: [{ threadId: "thr_synthetic", lastMessageAt: 900 }] }));
    expect(states.slice(start).some(state => state.status === "loading")).toBe(false);
  });
  it("removes a deleted row immediately while the rest of the list refreshes", async () => {
    const f = fixture([thread("thr_synthetic"), thread("thr_second")]);
    const { states } = await setup(f); let release!: () => void;
    f.setReadHook(() => new Promise<void>(resolve => { release = resolve; }));
    f.setRows([thread("thr_second")]); f.emit(changed("thr_synthetic", ["thread-deleted"], []));
    expect(states.at(-1)).toEqual({ status: "refreshing", rows: [{ threadId: "thr_second", lastMessageAt: 200 }] });
    await wait(() => expect(release).toBeTypeOf("function")); f.setReadHook(); release();
    await wait(() => expect(states.at(-1)?.status).toBe("ready"));
  });
  it("recovers from a transient RPC failure on the next message update, without polling", async () => {
    const { f, c, states } = await setup();
    f.setFailure(true); c.retry();
    await wait(() => expect(states.at(-1)?.status).toBe("error"));
    const failedCalls = f.calls.length;
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(60000);
      expect(f.calls).toHaveLength(failedCalls);
      f.emit(changed("thr_synthetic", ["title-changed"], []));
      f.emit(changed("thr_synthetic", ["events-appended"], ["item/agentMessage/delta"]));
      await vi.advanceTimersByTimeAsync(60000);
      expect(f.calls).toHaveLength(failedCalls);
    } finally { vi.useRealTimers(); }
    f.setFailure(false); f.histories.get("thr_synthetic")!.push(assistant(1000));
    for (let i = 0; i < 10; i++) f.emit(changed());
    await wait(() => expect(states.at(-1)).toEqual({ status: "ready", rows: [{ threadId: "thr_synthetic", lastMessageAt: 1000 }] }));
    expect(f.calls).toHaveLength(failedCalls + 1);
  });
  it("пустой успешный результат отличается от ошибки", async () => {
    const { states } = await setup(fixture([])); expect(states.at(-1)).toEqual({ status: "ready", rows: [] });
  });
  it("отмена destructive invalidation не выпускает старый snapshot", async () => {
    const { f, c, states } = await setup(); let release!: () => void; let entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.setReadHook(async () => { entered = true; await gate; }); c.retry();
    await wait(() => expect(entered).toBe(true)); const count = states.length;
    f.setRows([]); f.emit(changed("thr_synthetic", ["thread-deleted"], [])); release();
    await wait(() => expect(states.at(-1)).toEqual({ status: "ready", rows: [] }));
    expect(states.slice(count).filter(state => state.status === "ready").every(state => !state.rows.length)).toBe(true);
    expect(f.calls.at(-2)!.args.signal.aborted).toBe(true);
  });
  it("hidden/archived исчезают при сверке", async () => {
    const { f, states } = await setup(); f.setRows([thread("thr_synthetic", { visibility: "hidden" })]);
    f.emit(changed("thr_synthetic", ["archived-changed"], []));
    await wait(() => expect(states.at(-1)).toEqual({ status: "ready", rows: [] }));
  });
  it("unmount отменяет HTTP/worker, подписки и поздний ответ", async () => {
    const { f, c, states } = await setup(); let release!: () => void; let entered = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.setReadHook(async () => { entered = true; await gate; }); c.retry();
    await wait(() => expect(entered).toBe(true)); const count = states.length; c.dispose(); release();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(states).toHaveLength(count); expect(f.calls.at(-1)!.args.signal.aborted).toBe(true);
    expect([...f.listeners.values()].every(set => set.size === 0)).toBe(true);
  });
  it("постоянные item/completed не блокируют initial ready", async () => {
    const f = fixture(); f.setReadHook(async () => { await new Promise(resolve => setTimeout(resolve, 70)); });
    const flood = setInterval(() => f.emit(changed()), 5);
    try { const { states } = await setup(f); expect(states.at(-1)?.status).toBe("ready"); }
    finally { clearInterval(flood); }
  });
  it("loads 50 at a time, coalesces repeated scroll notifications and preserves the loaded extent on refresh", async () => {
    const f = fixture(Array.from({ length: 125 }, (_, i) => thread(`thr_${String(i).padStart(3, "0")}`)));
    for (let i = 0; i < 125; i++) f.histories.set(`thr_${String(i).padStart(3, "0")}`, [assistant(1000 + i)]);
    const { c, states } = await setup(f);
    expect(states.at(-1)?.rows).toHaveLength(50); expect(states.at(-1)?.hasMore).toBe(true);
    f.calls.length = 0;
    for (let i = 0; i < 20; i++) c.loadMore();
    await wait(() => expect(states.at(-1)?.rows).toHaveLength(100));
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.args.input.before).toEqual({ threadId: "thr_075", lastMessageAt: 1075 });
    c.retry(); await wait(() => expect(states.at(-1)?.status).toBe("ready"));
    expect(states.at(-1)?.rows).toHaveLength(100);
    c.loadMore(); await wait(() => expect(states.at(-1)?.rows).toHaveLength(125));
    expect(states.at(-1)?.hasMore).toBeUndefined();
    const calls = f.calls.length; c.loadMore(); await new Promise(resolve => setTimeout(resolve, 30));
    expect(f.calls).toHaveLength(calls);
  });
  it("message updates reorder loaded rows and insert newly recent chats without re-reading historical pages", async () => {
    const f = fixture(Array.from({ length: 125 }, (_, i) => thread(`thr_${i}`)));
    for (let i = 0; i < 125; i++) f.histories.set(`thr_${i}`, [assistant(1000 + i)]);
    const { c, states } = await setup(f); c.loadMore();
    await wait(() => expect(states.at(-1)?.rows).toHaveLength(100)); f.calls.length = 0;
    f.histories.get("thr_40")!.push(user(9000)); f.emit(changed("thr_40"));
    f.histories.get("thr_0")!.push(user(10000)); f.emit(changed("thr_0"));
    await wait(() => expect(states.at(-1)?.rows[0]?.threadId).toBe("thr_0"));
    expect(states.at(-1)?.rows).toHaveLength(101);
    expect(states.at(-1)?.rows[1]).toEqual({ threadId: "thr_40", lastMessageAt: 9000 });
    expect(f.calls).toHaveLength(1); expect(f.calls[0]!.args.input.threadIds).toEqual(["thr_40", "thr_0"]);
    c.loadMore(); await wait(() => expect(states.at(-1)?.rows).toHaveLength(125));
    expect(new Set(states.at(-1)!.rows.map(row => row.threadId)).size).toBe(125);
  });
  it("keeps verified pages on a pagination failure and retries only by explicit action", async () => {
    const { f, c, states } = await setup(fixture(Array.from({ length: 65 }, (_, i) => thread(`thr_${i}`))));
    f.setFailure(true); c.loadMore();
    await wait(() => expect(states.at(-1)?.pageError).toBe("Could not load more chats."));
    expect(states.at(-1)?.rows).toHaveLength(50);
    const calls = f.calls.length;
    vi.useFakeTimers();
    try { await vi.advanceTimersByTimeAsync(60000); expect(f.calls).toHaveLength(calls); }
    finally { vi.useRealTimers(); }
    c.loadMore(); await new Promise(resolve => setTimeout(resolve, 30)); expect(f.calls).toHaveLength(calls);
    f.setFailure(false); c.loadMore(true); await wait(() => expect(states.at(-1)?.rows).toHaveLength(65));
    expect(states.at(-1)?.pageError).toBeUndefined();
  });
  it("finds an old chat outside the initial 50 and clears search back to the latest page", async () => {
    const f = fixture(Array.from({ length: 80 }, (_, i) => thread(`thr_${i}`)));
    for (let i = 0; i < 80; i++) { f.histories.set(`thr_${i}`, [assistant(1000 + i)]); f.labels.set(`thr_${i}`, i === 0 ? "Старый Чат" : "Another chat"); }
    const { c, states } = await setup(f);
    expect(states.at(-1)?.rows.some(row => row.threadId === "thr_0")).toBe(false);
    c.setSearch(" СТАРЫЙ ");
    await wait(() => expect(states.at(-1)).toEqual({ status: "ready", rows: [{ threadId: "thr_0", lastMessageAt: 1000 }] }));
    c.setSearch(""); await wait(() => expect(states.at(-1)?.rows).toHaveLength(50));
    expect(states.at(-1)?.rows[0]?.threadId).toBe("thr_79");
  });
  it("never publishes an old search response after the query changes", async () => {
    const { f, c, states } = await setup(); let release!: () => void;
    f.setReadHook(() => new Promise<void>(resolve => { release = resolve; }));
    c.setSearch("synthetic"); await wait(() => expect(release).toBeTypeOf("function"));
    const count = states.length; c.setSearch("does-not-match"); f.setReadHook(); release();
    await wait(() => expect(states.at(-1)).toEqual({ status: "ready", rows: [] }));
    expect(states.slice(count).filter(state => state.status === "ready").every(state => state.rows.length === 0)).toBe(true);
  });
  it("cancels a pending older page when a destructive change invalidates it", async () => {
    const f = fixture(Array.from({ length: 80 }, (_, i) => thread(`thr_${i}`)));
    const { c, states } = await setup(f); let release!: () => void;
    f.setReadHook(() => new Promise<void>(resolve => { release = resolve; })); c.loadMore();
    await wait(() => expect(release).toBeTypeOf("function")); const pending = f.calls.at(-1)!;
    f.setRows(Array.from({ length: 79 }, (_, i) => thread(`thr_${i + 1}`)));
    f.emit(changed("thr_0", ["thread-deleted"], [])); f.setReadHook(); release();
    await wait(() => expect(states.at(-1)?.status).toBe("ready"));
    expect(pending.args.signal.aborted).toBe(true); expect(states.at(-1)?.rows).toHaveLength(50);
    expect(states.at(-1)?.rows.some(row => row.threadId === "thr_0")).toBe(false);
  });
  it("events-appended вместе со status не инвалидирует snapshot как destructive", async () => {
    const { f, states } = await setup(); f.histories.get("thr_synthetic")!.push(assistant(900, 900));
    f.emit(changed("thr_synthetic", ["events-appended", "status-changed"], ["item/completed"]));
    await wait(() => expect(states.at(-1)?.rows[0]?.lastMessageAt).toBe(900));
  });
});
