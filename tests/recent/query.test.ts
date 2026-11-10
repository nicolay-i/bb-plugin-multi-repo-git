import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryLatest } from "../../lib/recent/query-worker.mjs";
import { messageTime, topRecent, type MessageIndex, type EventRow } from "../../lib/recent/data.js";
import { assistant, event, tool, user } from "./fixtures";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); });
function database(path = ":memory:") {
  const db = new DatabaseSync(path);
  let closed = false;
  const close = () => { if (!closed) { db.close(); closed = true; } };
  cleanups.push(close);
  db.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY,visibility TEXT DEFAULT 'visible',archived_at INTEGER,deleted_at INTEGER,updated_at INTEGER,project_id TEXT DEFAULT 'proj_test',title TEXT,title_fallback TEXT);
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,deleted_at INTEGER);
    INSERT INTO projects VALUES('proj_test','Synthetic project',NULL);
    CREATE TABLE events(id TEXT PRIMARY KEY,thread_id TEXT,sequence INTEGER,created_at INTEGER,type TEXT,item_kind TEXT,parent_tool_call_id TEXT,data TEXT);
    CREATE INDEX events_thread_type_sequence_idx ON events(thread_id,type,sequence);
    CREATE INDEX events_thread_type_item_kind_sequence_idx ON events(thread_id,type,item_kind,sequence);
    CREATE INDEX events_completed_item_truncation_idx ON events(item_kind,created_at,id) WHERE type='item/completed';`);
  let next = 0;
  const histories = new Map<string, EventRow[]>();
  function thread(id: string, visibility = "visible", archived: number | null = null, deleted: number | null = null) {
    db.prepare("INSERT INTO threads(id,visibility,archived_at,deleted_at,updated_at) VALUES(?,?,?,?,?)").run(id, visibility, archived, deleted, 999999);
    histories.set(id, []);
  }
  function add(id: string, row: EventRow, options: { nullKind?: boolean; parent?: string } = {}) {
    const item = (row.data as any).item;
    db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?)").run(`evt_${++next}`, id, row.seq, row.createdAt, row.type,
      options.nullKind ? null : item?.type ?? null, options.parent ?? item?.parentToolCallId ?? null, JSON.stringify(row.data));
    histories.get(id)!.push(row);
  }
  function oracle(excluded = new Set<string>()) {
    const index = new Map<string, MessageIndex>();
    for (const row of db.prepare("SELECT id FROM threads WHERE visibility='visible' AND archived_at IS NULL AND deleted_at IS NULL").all() as { id: string }[]) {
      const times = histories.get(row.id)!.flatMap(event => { const at = messageTime(event); return at === null ? [] : [at]; });
      if (excluded.has(row.id)) continue;
      index.set(row.id, { lastMessageAt: times.length ? Math.max(...times) : null, lastSeq: 0 });
    }
    return topRecent(index);
  }
  return { db, thread, add, oracle, close };
}

describe("Точный read-only server query", () => {
  it("совпадает с полным oracle для240тредов; старый тред с новым user не теряется", () => {
    const f = database();
    for (let i = 0; i < 240; i++) {
      const id = `thr_${String(i).padStart(3, "0")}`; f.thread(id);
      f.add(id, user(i + 1, 1)); f.add(id, assistant(1000 + i, 2));
      for (let n = 0; n < 5; n++) f.add(id, tool(50000 + n, n + 3));
    }
    f.add("thr_000", user(99999, 99));
    f.add("thr_001", event("system/manager/user_message", { text: "legacy" }, 77777, 90));
    f.add("thr_002", assistant(88888, 90), { nullKind: true });
    f.add("thr_003", assistant(66666, 90, { type: "plan" }));
    expect(queryLatest(f.db).rows).toEqual(f.oracle());
    expect(queryLatest(f.db).rows[0]).toEqual({ threadId: "thr_000", lastMessageAt: 99999 });
  });
  it("legacy NULL completions используют existing global date range, не historical thread walk", () => {
    const f = database();
    for (let i = 0; i < 75; i++) {
      const id = `thr_${String(i).padStart(3, "0")}`; f.thread(id); f.add(id, assistant(1000 + i, 1));
    }
    f.thread("thr_legacy");
    for (let i = 0; i < 1500; i++) f.add("thr_legacy", tool(i % 10, i + 1), { nullKind: true });
    f.add("thr_legacy", assistant(9999, 2000), { nullKind: true });
    const prepare = vi.spyOn(f.db, "prepare");
    expect(queryLatest(f.db).rows).toEqual(f.oracle());
    const sql = prepare.mock.calls.find(([sql]) => sql.includes("WITH recent_ids"))![0];
    const plan = f.db.prepare("EXPLAIN QUERY PLAN " + sql).all({ cutoff: 1000, upper: Number.MAX_SAFE_INTEGER, matches: "[]" }) as { detail: string }[];
    expect(plan.some(row => row.detail.includes("events_completed_item_truncation_idx") && row.detail.includes("created_at>"))).toBe(true);
    expect(plan.some(row => row.detail.includes("events_thread_type_item_kind_sequence_idx"))).toBe(false);
    prepare.mockRestore();
  });
  it("не предполагает sequence~createdAt и не останавливается после первого текста", () => {
    const f = database(); f.thread("thr_one");
    f.add("thr_one", user(500, 1)); f.add("thr_one", assistant(400, 2));
    for (let i = 0; i < 250; i++) f.add("thr_one", tool(1000 + i, 3 + i));
    expect(queryLatest(f.db).rows).toEqual([{ threadId: "thr_one", lastMessageAt: 500 }]);
  });
  it("обрабатывает ВСЕ равные даты порога до стабильного top50", () => {
    const f = database();
    for (let i = 79; i >= 0; i--) { const id = `thr_${String(i).padStart(3, "0")}`; f.thread(id); f.add(id, assistant(1000, 1)); }
    expect(queryLatest(f.db).rows).toEqual(f.oracle());
    expect(queryLatest(f.db).rows.at(-1)?.threadId).toBe("thr_049");
  });
  it("нет недоказанного порога при числе assistant-тредов меньше50", () => {
    const f = database(); f.thread("thr_assistant"); f.thread("thr_user"); f.thread("thr_legacy");
    f.add("thr_assistant", assistant(1000, 1)); f.add("thr_user", user(1, 1));
    f.add("thr_legacy", event("system/manager/user_message", { text: "legacy" }, 2, 1));
    expect(queryLatest(f.db).rows).toEqual(f.oracle()); expect(queryLatest(f.db).rows).toHaveLength(3);
  });
  it("legacy null item_kind, plan и вложения сохраняют семантику", () => {
    const f = database();
    for (const id of ["thr_legacy", "thr_plan", "thr_file", "thr_hiddenpart"]) f.thread(id);
    f.add("thr_legacy", assistant(300, 1), { nullKind: true });
    f.add("thr_plan", assistant(400, 1, { type: "plan" }));
    f.add("thr_file", user(500, 1, { input: [{ type: "localFile", path: "synthetic" }] }));
    f.add("thr_hiddenpart", user(99999, 1, { input: [{ type: "image", visibility: "agent-only" }] }));
    expect(queryLatest(f.db).rows).toEqual(f.oracle());
  });
  it("JS Unicode trim, системные запросы/retry/reasoning/delta/context-clear не поднимают дату", () => {
    const f = database(); f.thread("thr_one"); f.add("thr_one", user(100, 1));
    f.add("thr_one", user(999, 2, { input: [{ type: "text", text: " \u00a0\u2003\ufeff " }] }));
    f.add("thr_one", user(999, 3, { initiator: "system" }));
    f.add("thr_one", user(999, 4, { retryOfRequestId: "retry" }));
    f.add("thr_one", assistant(999, 5, { type: "reasoning", text: "reasoning" }));
    f.add("thr_one", event("item/agentMessage/delta", { delta: "partial" }, 999, 6));
    f.add("thr_one", event("system/operation", { operation: "context_clear" }, 999, 7));
    expect(queryLatest(f.db).rows).toEqual([{ threadId: "thr_one", lastMessageAt: 100 }]);
  });
  it("исключает parentToolCallId и из JSON, и из нормализованной колонки", () => {
    const f = database(); f.thread("thr_one"); f.add("thr_one", user(100, 1));
    f.add("thr_one", assistant(999, 2, { parentToolCallId: "tool" }));
    f.add("thr_one", assistant(999, 3), { parent: "tool" });
    expect(queryLatest(f.db).rows).toEqual([{ threadId: "thr_one", lastMessageAt: 100 }]);
  });
  it("исключает hidden/archived/deleted до global limit, metadata rename/read не влияет", () => {
    const f = database();
    f.thread("thr_valid"); f.thread("thr_hidden", "hidden"); f.thread("thr_archived", "visible", 1); f.thread("thr_deleted", "visible", null, 1);
    for (const id of ["thr_valid", "thr_hidden", "thr_archived", "thr_deleted"]) f.add(id, assistant(id === "thr_valid" ? 100 : 999, 1));
    expect(queryLatest(f.db).rows).toEqual(f.oracle());
    f.db.prepare("UPDATE threads SET updated_at=99999999").run();
    expect(queryLatest(f.db).rows).toEqual([{ threadId: "thr_valid", lastMessageAt: 100 }]);
  });
  it("replacement user до final и edited assistant после final меняют порядок", () => {
    const f = database(); f.thread("thr_target"); f.thread("thr_comparator");
    f.add("thr_target", assistant(100, 1)); f.add("thr_comparator", assistant(200, 1));
    expect(queryLatest(f.db).rows[0]?.threadId).toBe("thr_comparator");
    f.add("thr_target", user(300, 2)); expect(queryLatest(f.db).rows[0]?.lastMessageAt).toBe(300);
    f.add("thr_target", assistant(400, 3)); expect(queryLatest(f.db).rows[0]?.lastMessageAt).toBe(400);
  });
  it("отличает пустой результат от ошибки и отказывает без обязательного existing index", () => {
    const f = database(); expect(queryLatest(f.db).rows).toEqual([]);
    f.db.exec("DROP INDEX events_completed_item_truncation_idx");
    expect(() => queryLatest(f.db)).toThrow();
  });
  it("не возвращает тела сообщений, поддерживает top20 и принудительный budget", () => {
    const f = database(); f.thread("thr_one"); f.add("thr_one", user(100, 1));
    expect(queryLatest(f.db, 20).rows).toEqual([{ threadId: "thr_one", lastMessageAt: 100 }]);
    expect(JSON.stringify(queryLatest(f.db))).not.toContain('"text"');
    expect(() => queryLatest(f.db, 51)).toThrow(); expect(() => queryLatest(f.db, 50, -1)).toThrow();
  });
  it("does not count scheduler pauses as query CPU work", () => {
    const f = database(); f.thread("thr_one"); f.add("thr_one", user(100, 1));
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(10000);
    expect(queryLatest(f.db)).toEqual({ rows: [{ threadId: "thr_one", lastMessageAt: 100 }], nextCursor: null, queryMs: 10000 });
  });
  it("still rejects a query that exhausts its CPU work budget", () => {
    const f = database(); f.thread("thr_one"); f.add("thr_one", user(100, 1));
    vi.spyOn(process, "cpuUsage").mockReturnValueOnce({ user: 0, system: 0 }).mockReturnValue({ user: 6000000, system: 0 });
    expect(() => queryLatest(f.db)).toThrow();
  });
  it("pages through every thread once, including ties and older messages from already shown threads", () => {
    const f = database();
    for (let i = 0; i < 127; i++) {
      const id = `thr_${String(i).padStart(3, "0")}`; f.thread(id);
      f.add(id, user(i % 5, 1));
      f.add(id, assistant(1000 + i % 3, 2), { nullKind: i % 7 === 0 });
      f.add(id, user(1000 + i % 4, 3));
      f.add(id, tool(999999, 4));
    }
    const seen = new Set<string>(); let before;
    for (let n = 0; n < 3; n++) {
      const page = queryLatest(f.db, 50, 5000, { before });
      expect(page.rows).toEqual(f.oracle(seen));
      for (const row of page.rows) { expect(seen.has(row.threadId)).toBe(false); seen.add(row.threadId); }
      before = page.nextCursor ?? undefined;
    }
    expect(before).toBeUndefined(); expect(seen.size).toBe(127);
  });
  it("searches older titles and projects with Unicode case folding and literal wildcard characters", () => {
    const f = database();
    for (let i = 0; i < 70; i++) { const id = `thr_${i}`; f.thread(id); f.add(id, assistant(1000 + i, 1)); }
    f.db.prepare("UPDATE threads SET title='Старый ЧАТ 100%_' WHERE id='thr_0'").run();
    f.add("thr_0", assistant(900, 2, { text: "Distinctive body text that is not a title" }));
    expect(queryLatest(f.db, 50, 5000, { search: "distinctive body text" }).rows).toEqual([]);
    expect(queryLatest(f.db, 50, 5000, { search: "  СТАРЫЙ чат 100%_  " }).rows).toEqual([{ threadId: "thr_0", lastMessageAt: 1000 }]);
    expect(queryLatest(f.db, 50, 5000, { search: "not-a-chat" }).rows).toEqual([]);
    expect(queryLatest(f.db, 50, 5000, { search: "SYNTHETIC PROJECT" }).rows).toEqual(f.oracle());
    expect(queryLatest(f.db, 50, 5000, { threadIds: ["thr_0", "thr_1"] }).rows).toHaveLength(2);
    expect(queryLatest(f.db, 50, 5000, { threadIds: [] }).rows).toEqual([]);
  });
  it("streams broad search matches from the date index instead of sorting every matching history", () => {
    const f = database();
    for (let i = 0; i < 80; i++) { const id = `thr_${i}`; f.thread(id); f.add(id, assistant(1000 + i, 1)); }
    const prepare = vi.spyOn(f.db, "prepare");
    expect(queryLatest(f.db, 50, 5000, { search: "Synthetic project" }).rows).toEqual(f.oracle());
    const sql = prepare.mock.calls.map(([sql]) => sql).find(sql => sql.startsWith("SELECT e.thread_id"))!;
    expect(sql).toContain("INDEXED BY events_completed_item_truncation_idx");
    expect(sql).not.toContain("events_thread_type_item_kind_sequence_idx");
    expect(sql).not.toContain("JOIN events");
  });
  it("keeps the cursor valid when an older thread receives a new saved message between pages", () => {
    const f = database();
    for (let i = 0; i < 120; i++) { const id = `thr_${i}`; f.thread(id); f.add(id, assistant(i, 1)); }
    const first = queryLatest(f.db);
    f.add("thr_0", user(99999, 2));
    const next = queryLatest(f.db, 50, 5000, { before: first.nextCursor! });
    expect(next.rows).toHaveLength(50);
    expect(next.rows.some(row => row.threadId === "thr_0")).toBe(false);
    expect(new Set([...first.rows, ...next.rows].map(row => row.threadId)).size).toBe(100);
  });
  it("cursor witnesses use global date ranges and native metadata membership, not nested historical thread walks", () => {
    const f = database(); f.thread("thr_one"); f.add("thr_one", assistant(100, 1));
    const prepare = vi.spyOn(f.db, "prepare");
    expect(queryLatest(f.db, 50, 5000, { before: { threadId: "thr_cutoff", lastMessageAt: 200 } }).rows).toHaveLength(1);
    const witnesses = prepare.mock.calls.map(([sql]) => sql).filter(sql => sql.includes("recent_unseen"));
    expect(witnesses).toHaveLength(2);
    for (const sql of witnesses) {
      const plan = f.db.prepare("EXPLAIN QUERY PLAN " + sql).all({ matches: '["thr_one"]', cutoff: 200,
        upper: Number.MAX_SAFE_INTEGER, cursorId: "thr_cutoff" }) as { detail: string }[];
      expect(plan.some(row => row.detail.includes("events_completed_item_truncation_idx") && row.detail.includes("created_at>"))).toBe(true);
    }
    expect(prepare.mock.calls.some(([sql]) => sql.startsWith("SELECT 1 FROM events"))).toBe(false);
  });
  it("bounds deep-page work on 500,000 historical messages without a new database index", () => {
    const f = database();
    const insert = f.db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?)");
    const body = JSON.stringify({ item: { type: "agentMessage", text: "Synthetic benchmark ".repeat(20) } });
    f.db.exec("BEGIN");
    for (let i = 0; i < 2000; i++) {
      const id = `thr_${String(i).padStart(5, "0")}`; f.thread(id);
      for (let n = 0; n < 250; n++) insert.run(`evt_${i}_${n}`, id, n + 1, n === 249 ? 100000 + i : n,
        "item/completed", "agentMessage", null, body);
    }
    f.db.exec("COMMIT");
    const first = queryLatest(f.db);
    const last = queryLatest(f.db, 50, 5000, { before: { lastMessageAt: 100050, threadId: "thr_00050" } });
    expect(first.rows).toHaveLength(50); expect(last.rows).toHaveLength(50); expect(last.nextCursor).toBeNull();
    console.info("Recent 500k-message spike", { firstMs: first.queryMs, finalPageMs: last.queryMs });
  }, 60000);
  it("фактически работает в node:sqlite readOnly; запись отказана, файл не изменён", () => {
    const base = resolve(".tmp"); mkdirSync(base, { recursive: true }); const dir = mkdtempSync(join(base, "sqlite-unit-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "test.db"), f = database(path); f.thread("thr_one"); f.add("thr_one", user(100, 1)); f.close();
    const before = statSync(path); const readonly = new DatabaseSync(path, { readOnly: true });
    try { expect(queryLatest(readonly).rows).toEqual([{ threadId: "thr_one", lastMessageAt: 100 }]); expect(() => readonly.exec("CREATE TABLE forbidden(id)")).toThrow(); }
    finally { readonly.close(); }
    expect(statSync(path).mtimeMs).toBe(before.mtimeMs); expect(statSync(path).size).toBe(before.size);
  });
});
