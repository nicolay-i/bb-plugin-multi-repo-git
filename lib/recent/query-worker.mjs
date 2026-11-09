import { isMainThread } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// A second SQLite implementation must never open BB's WAL inside its process.
// Refuse the unsafe worker_threads path before importing node:sqlite.
if (!isMainThread) throw new Error("Recent SQLite reader requires a separate process.");

// Runs inside a read-only SQLite connection. No messages leave this process.
export function queryLatest(db, limit = 50, budgetMs = 5000) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Invalid result limit");
  if (!Number.isFinite(budgetMs) || budgetMs < 0) throw new Error("Invalid CPU budget");
  const began = performance.now();
  const cpuStarted = process.cpuUsage();
  const cursors = [];
  db.function("recent_nonempty", { deterministic: true }, value => {
    // The parent enforces an 8s wall deadline. This budget bounds query work,
    // not time for which the OS descheduled this worker under host load.
    const cpu = process.cpuUsage(cpuStarted);
    if ((cpu.user + cpu.system) / 1000 > budgetMs) throw new Error("Read query CPU budget exceeded");
    return typeof value === "string" && value.trim().length > 0 ? 1 : 0;
  });
  const visible = "t.deleted_at IS NULL AND t.archived_at IS NULL AND t.visibility='visible'";
  const assistant = `COALESCE(e.parent_tool_call_id,'')='' AND COALESCE(json_extract(e.data,'$.item.parentToolCallId'),'')=''
    AND json_extract(e.data,'$.item.type') IN ('agentMessage','plan') AND recent_nonempty(json_extract(e.data,'$.item.text'))=1`;
  const modern = kind => `SELECT e.thread_id threadId,e.created_at lastMessageAt FROM events e
    INDEXED BY events_completed_item_truncation_idx CROSS JOIN threads t ON t.id=e.thread_id
    WHERE e.type='item/completed' AND e.item_kind='${kind}' AND ${visible} AND ${assistant}
    ORDER BY e.created_at DESC,e.id DESC`;
  const user = `COALESCE(json_extract(e.data,'$.initiator'),'')<>'system'
    AND COALESCE(json_extract(e.data,'$.retryOfRequestId'),'')=''
    AND EXISTS (SELECT 1 FROM json_each(e.data,'$.input') p
      WHERE COALESCE(json_extract(p.value,'$.visibility'),'')<>'agent-only'
      AND (json_extract(p.value,'$.type') IN ('image','localImage','localFile')
        OR (json_extract(p.value,'$.type')='text' AND recent_nonempty(json_extract(p.value,'$.text'))=1)))`;
  const ids = condition => `SELECT e.id FROM threads t
    JOIN events e INDEXED BY events_thread_type_sequence_idx ON e.thread_id=t.id WHERE ${visible} AND ${condition} AND e.created_at>=?1`;
  // The same existing global timestamp index also contains NULL item_kind.
  // Do not walk all historical legacy completions just to discard old dates.
  const legacyAssistantIds = `SELECT e.id FROM events e INDEXED BY events_completed_item_truncation_idx
    CROSS JOIN threads t ON t.id=e.thread_id WHERE e.type='item/completed' AND e.item_kind IS NULL
    AND e.created_at>=?1 AND ${visible}`;
  // Only ID metadata is materialized. Historical message JSON below a proven
  // timestamp bound is never decoded. Null item_kind covers legacy rows.
  const other = `WITH recent_ids AS MATERIALIZED (
    ${ids("e.type='client/turn/requested'")}
    UNION ALL ${ids("e.type='system/manager/user_message'")}
    UNION ALL ${legacyAssistantIds}
  ) SELECT e.thread_id threadId,MAX(e.created_at) lastMessageAt FROM recent_ids r
    JOIN events e ON e.id=r.id WHERE
      (e.type='client/turn/requested' AND ${user})
      OR (e.type='system/manager/user_message' AND recent_nonempty(json_extract(e.data,'$.text'))=1)
      OR (e.type='item/completed' AND ${assistant}) GROUP BY e.thread_id`;
  db.exec("BEGIN");
  try {
    const index = new Map();
    let cutoff = null;
    const streams = ["agentMessage", "plan"].map(kind => {
      const cursor = db.prepare(modern(kind)).iterate();
      cursors.push(cursor);
      return { cursor, head: cursor.next() };
    });
    while (streams.some(stream => !stream.head.done)) {
      const stream = streams.filter(stream => !stream.head.done)
        .sort((a, b) => b.head.value.lastMessageAt - a.head.value.lastMessageAt)[0];
      const row = stream.head.value;
      if (cutoff !== null && row.lastMessageAt < cutoff) break;
      if (!index.has(row.threadId)) index.set(row.threadId, row);
      if (cutoff === null && index.size >= limit) cutoff = row.lastMessageAt;
      stream.head = stream.cursor.next();
    }
    // These are actual eligible messages from distinct threads, not candidate
    // metadata. Anything older cannot enter the final top. Consume ALL ties.
    // With fewer than limit assistant threads there is no cutoff at all.
    for (const row of db.prepare(other).all(cutoff ?? Number.MIN_SAFE_INTEGER)) {
      const previous = index.get(row.threadId);
      if (!previous || row.lastMessageAt > previous.lastMessageAt) index.set(row.threadId, row);
    }
    const rows = [...index.values()].sort((a, b) => b.lastMessageAt - a.lastMessageAt ||
      (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0)).slice(0, limit)
      .map(({ threadId, lastMessageAt }) => ({ threadId, lastMessageAt }));
    return { rows, queryMs: Math.round((performance.now() - began) * 100) / 100 };
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
    process.send({ phase: "opened", openMs: performance.now() - began, pid: process.pid });
    queryBegan = performance.now(); queryCpu = process.cpuUsage();
    const result = queryLatest(db);
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
