import { isMainThread } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// A second SQLite implementation must never open BB's WAL inside its process.
// Refuse the unsafe worker_threads path before importing node:sqlite.
if (!isMainThread) throw new Error("Recent SQLite reader requires a separate process.");

// Runs inside a read-only SQLite connection. No messages leave this process.
export function queryLatest(db, limit = 50, budgetMs = 5000, options = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Invalid result limit");
  if (!Number.isFinite(budgetMs) || budgetMs < 0) throw new Error("Invalid CPU budget");
  const { before, search = "", threadIds } = options;
  if (typeof search !== "string" || search.length > 500 ||
      (before !== undefined && (!Number.isSafeInteger(before.lastMessageAt) || typeof before.threadId !== "string" || !before.threadId || before.threadId.length > 200)) ||
      (threadIds !== undefined && (!Array.isArray(threadIds) || threadIds.length > 50 || threadIds.some(id => typeof id !== "string" || !id || id.length > 200))))
    throw new Error("Invalid page input");
  const began = performance.now(), cpuStarted = process.cpuUsage(), cursors = [];
  const checkBudget = () => {
    const cpu = process.cpuUsage(cpuStarted);
    if ((cpu.user + cpu.system) / 1000 > budgetMs) throw new Error("Read query CPU budget exceeded");
  };
  db.function("recent_nonempty", { deterministic: true }, value => {
    checkBudget(); return typeof value === "string" && value.trim().length > 0 ? 1 : 0;
  });
  const needle = search.trim().toLowerCase();
  db.function("recent_matches", { deterministic: true }, value => {
    checkBudget(); return typeof value === "string" && value.toLowerCase().includes(needle) ? 1 : 0;
  });
  let narrow = false;
  const assistant = `COALESCE(e.parent_tool_call_id,'')='' AND COALESCE(json_extract(e.data,'$.item.parentToolCallId'),'')=''
    AND json_extract(e.data,'$.item.type') IN ('agentMessage','plan') AND recent_nonempty(json_extract(e.data,'$.item.text'))=1`;
  const user = `COALESCE(json_extract(e.data,'$.initiator'),'')<>'system'
    AND COALESCE(json_extract(e.data,'$.retryOfRequestId'),'')=''
    AND EXISTS (SELECT 1 FROM json_each(e.data,'$.input') p
      WHERE COALESCE(json_extract(p.value,'$.visibility'),'')<>'agent-only'
      AND (json_extract(p.value,'$.type') IN ('image','localImage','localFile')
        OR (json_extract(p.value,'$.type')='text' AND recent_nonempty(json_extract(p.value,'$.text'))=1)))`;
  const modern = (kind, extra = "") => `SELECT e.thread_id threadId,e.created_at lastMessageAt FROM ${narrow
    ? "json_each($matches) m JOIN events e INDEXED BY events_thread_type_item_kind_sequence_idx ON e.thread_id=m.value"
    : "events e INDEXED BY events_completed_item_truncation_idx"}
    WHERE e.type='item/completed' AND e.item_kind='${kind}' AND e.created_at>=$cutoff AND e.created_at<=$upper
      AND e.thread_id IN (SELECT value FROM json_each($matches)) ${extra} AND ${assistant}
    ORDER BY e.created_at DESC,e.id DESC`;
  const ids = type => `SELECT e.id FROM json_each($matches) m
    JOIN events e INDEXED BY events_thread_type_sequence_idx ON e.thread_id=m.value
    WHERE e.type='${type}' AND e.created_at>=$cutoff AND e.created_at<=$upper`;
  // Existing global timestamp index, including legacy NULL item_kind. Neither
  // cursor checks nor visibility filtering walk historical tool/stream events.
  const other = `WITH recent_ids AS MATERIALIZED (
    ${ids("client/turn/requested")}
    UNION ALL ${ids("system/manager/user_message")}
    UNION ALL SELECT e.id FROM events e INDEXED BY events_completed_item_truncation_idx
      WHERE e.type='item/completed' AND e.item_kind IS NULL AND e.created_at>=$cutoff AND e.created_at<=$upper
        AND e.thread_id IN (SELECT value FROM json_each($matches))
  ) SELECT e.thread_id threadId,MAX(e.created_at) lastMessageAt FROM recent_ids r
    JOIN events e ON e.id=r.id WHERE
      (e.type='client/turn/requested' AND ${user})
      OR (e.type='system/manager/user_message' AND recent_nonempty(json_extract(e.data,'$.text'))=1)
      OR (e.type='item/completed' AND ${assistant}) GROUP BY e.thread_id`;
  db.exec("BEGIN");
  try {
    // Materialize only native metadata. Membership is tested on e.thread_id,
    // before decoding event JSON, including for archived/hidden conversations.
    const selected = threadIds === undefined ? null : new Set(threadIds);
    let matches = db.prepare(`SELECT t.id FROM threads t ${needle ? "JOIN projects p ON p.id=t.project_id" : ""}
      WHERE t.deleted_at IS NULL AND t.archived_at IS NULL AND t.visibility='visible' ${needle
        ? "AND p.deleted_at IS NULL AND recent_matches(COALESCE(NULLIF(t.title,''),NULLIF(t.title_fallback,''),'New thread') || ' ' || p.name)=1" : ""}`)
      .all().map(row => row.id).filter(id => selected === null || selected.has(id));
    // Broad matches can fill a page from the date index without sorting their
    // entire history. A small filter uses the thread index to avoid unrelated rows.
    narrow = (!!needle || threadIds !== undefined) && matches.length <= limit;
    // Prepare even for an empty list: missing required native indexes fail closed.
    const statements = ["agentMessage", "plan"].map(kind => db.prepare(modern(kind)));
    const others = db.prepare(other);
    if (before && matches.length) {
      const newer = new Set();
      let checks = 0;
      db.function("recent_unseen", id => {
        if (++checks % 256 === 0) checkBudget();
        return newer.has(id) ? 0 : 1;
      });
      const future = { matches: JSON.stringify(matches), cutoff: before.lastMessageAt, upper: Number.MAX_SAFE_INTEGER };
      for (const kind of ["agentMessage", "plan"]) {
        const cursor = db.prepare(modern(kind, "AND (e.created_at>$cutoff OR e.thread_id<=$cursorId) AND recent_unseen(e.thread_id)=1"))
          .iterate({ ...future, cursorId: before.threadId });
        cursors.push(cursor);
        for (const row of cursor) newer.add(row.threadId);
      }
      const remaining = matches.filter(id => !newer.has(id));
      if (remaining.length) for (const row of others.all({ ...future, matches: JSON.stringify(remaining) })) {
        if (row.lastMessageAt > before.lastMessageAt || row.threadId <= before.threadId) newer.add(row.threadId);
      }
      // Exclude whole threads with newer eligible messages, not just their newer
      // events. No nested historical lookups from a per-row callback.
      matches = matches.filter(id => !newer.has(id));
    }
    const index = new Map();
    let cutoff = null;
    if (matches.length) {
      const bindings = { matches: JSON.stringify(matches), upper: before?.lastMessageAt ?? Number.MAX_SAFE_INTEGER, cutoff: Number.MIN_SAFE_INTEGER };
      const streams = statements.map(statement => {
        const cursor = statement.iterate(bindings); cursors.push(cursor);
        return { cursor, head: cursor.next() };
      });
      const target = Math.min(limit + 1, matches.length);
      while (streams.some(stream => !stream.head.done)) {
        const stream = streams.filter(stream => !stream.head.done)
          .sort((a, b) => b.head.value.lastMessageAt - a.head.value.lastMessageAt)[0];
        const row = stream.head.value;
        if (cutoff !== null && row.lastMessageAt < cutoff) break;
        if (!index.has(row.threadId)) index.set(row.threadId, row);
        if (cutoff === null && index.size >= target) cutoff = row.lastMessageAt;
        stream.head = stream.cursor.next();
      }
      // Actual eligible messages prove the bound. Consume ALL timestamp ties.
      // With fewer than target assistant threads there is no guessed cutoff.
      for (const row of others.all({ ...bindings, cutoff: cutoff ?? Number.MIN_SAFE_INTEGER })) {
        const previous = index.get(row.threadId);
        if (!previous || row.lastMessageAt > previous.lastMessageAt) index.set(row.threadId, row);
      }
    }
    const rows = [...index.values()].sort((a, b) => b.lastMessageAt - a.lastMessageAt ||
      (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0));
    checkBudget();
    return { rows: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1] : null,
      queryMs: Math.round((performance.now() - began) * 100) / 100 };
  } finally {
    for (const cursor of cursors) cursor.return?.();
    db.exec("ROLLBACK"); // End the read snapshot; this connection cannot write.
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (typeof process.send !== "function" || !process.connected) throw new Error("Recent reader requires a child-process IPC channel.");
  let db;
  const began = performance.now();
  let queryBegan = null, queryCpu = null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(process.argv[2], { readOnly: true });
    const input = new Promise(resolve => process.once("message", resolve));
    process.send({ phase: "opened", openMs: performance.now() - began, pid: process.pid });
    const options = await input;
    queryBegan = performance.now(); queryCpu = process.cpuUsage();
    const result = queryLatest(db, 50, 5000, options);
    const cpu = process.cpuUsage(queryCpu);
    db.close(); db = undefined;
    process.send({ phase: "finished", queryMs: result.queryMs,
      wallMs: performance.now() - queryBegan, cpuMs: (cpu.user + cpu.system) / 1000 });
    process.send({ phase: "result", result });
  } catch {
    // Never serialize SQLite/JSON error messages: they can contain row text.
    const cpu = queryCpu === null ? null : process.cpuUsage(queryCpu);
    process.send({ phase: "failed", queryStarted: queryBegan !== null,
      wallMs: performance.now() - (queryBegan ?? began), cpuMs: cpu === null ? 0 : (cpu.user + cpu.system) / 1000 });
  } finally {
    db?.close();
    process.disconnect();
  }
}
