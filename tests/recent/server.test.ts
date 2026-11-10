import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../../lib/recent/server.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function host(slow = false) {
  const base = resolve(".tmp"); mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "rpc-unit-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const pidFile = join(dir, "worker-heartbeat.txt");
  if (slow) {
    mkdirSync(join(dir, "lib/recent"), { recursive: true });
    writeFileSync(join(dir, "lib/recent/query-worker.mjs"), `import{writeFileSync,appendFileSync}from'node:fs';writeFileSync(${JSON.stringify(pidFile)},'started');setInterval(()=>appendFileSync(${JSON.stringify(pidFile)},'.'),10);`);
  } else {
    const db = new DatabaseSync(join(dir, "bb.db"));
    db.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY,visibility TEXT,archived_at INTEGER,deleted_at INTEGER,project_id TEXT DEFAULT 'proj_test',title TEXT DEFAULT 'Synthetic chat',title_fallback TEXT);
      CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT,deleted_at INTEGER);
      INSERT INTO projects VALUES('proj_test','Synthetic project',NULL);
      CREATE TABLE events(id TEXT PRIMARY KEY,thread_id TEXT,sequence INTEGER,created_at INTEGER,type TEXT,item_kind TEXT,parent_tool_call_id TEXT,data TEXT);
      CREATE INDEX events_thread_type_sequence_idx ON events(thread_id,type,sequence);
      CREATE INDEX events_thread_type_item_kind_sequence_idx ON events(thread_id,type,item_kind,sequence);
      CREATE INDEX events_completed_item_truncation_idx ON events(item_kind,created_at,id) WHERE type='item/completed';
      INSERT INTO threads(id,visibility,archived_at,deleted_at) VALUES('thr_synthetic','visible',NULL,NULL);`);
    db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?)").run("evt_synthetic", "thr_synthetic", 1, 100,
      "client/turn/requested", null, null, JSON.stringify({ initiator: "user", input: [{ type: "text", text: "synthetic" }] }));
    db.close();
  }
  const subscribe = vi.fn(() => () => {});
  const h = createFakePluginHost({ pluginId: "multi-repo-git", dataDir: dir,
    sdk: { subscribe, plugins: { list: async () => ({ plugins: [{ id: "multi-repo-git", rootDir: slow ? dir : process.cwd() }] } as any) } },
  });
  await plugin(h.bb); cleanups.push(() => h.harness.dispose());
  return { ...h, pidFile, dir, subscribe };
}

describe("Server RPC boundary and real worker lifecycle", () => {
  it("выполняет native read-only worker и возвращает только bounded metadata", async () => {
    const { harness } = await host();
    expect(await harness.callRpc("recent_latest", {})).toEqual({ rows: [{ threadId: "thr_synthetic", lastMessageAt: 100 }], nextCursor: null, queryMs: expect.any(Number) });
    const line = harness.logEntries.find(entry => entry.message.startsWith("recent-query "))!.message;
    const metrics = JSON.parse(line.slice("recent-query ".length));
    expect(metrics).toMatchObject({ reason: "success", activeAtStart: 1, maxWorkersSinceReload: 1,
      workerPid: expect.any(Number), workerSpawnedMs: expect.any(Number), workerStartedMs: expect.any(Number), telemetry: { phase: "finished", queryMs: expect.any(Number), cpuMs: expect.any(Number) } });
    expect(metrics.workerPid).not.toBe(process.pid);
    expect(line).not.toMatch(/thr_synthetic|synthetic|bb\.db|rows|text/);
    await expect(harness.callRpc("recent_latest", { sql: "SELECT anything", path: "outside" })).rejects.toThrow();
  });
  it("accepts a bounded Unicode query even when lowercasing expands its length", async () => {
    const h = await host();
    expect(await h.harness.callRpc("recent_latest", { search: "İ".repeat(500) })).toMatchObject({ rows: [], nextCursor: null });
  });
  it("does not inherit server NODE_OPTIONS preloads into the child", async () => {
    const previous = process.env.NODE_OPTIONS;
    try {
      process.env.NODE_OPTIONS = "--import /must-not-be-loaded-by-recent-reader.mjs";
      const h = await host();
      expect(await h.harness.callRpc("recent_latest", {})).toMatchObject({ rows: [{ threadId: "thr_synthetic" }] });
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previous;
    }
  });
  it("shares concurrent reads within one persisted-data revision", async () => {
    const h = await host();
    const [a, b] = await Promise.all([
      h.harness.callRpc("recent_latest", {}), h.harness.callRpc("recent_latest", {}),
    ]);
    expect(a).toEqual(b);
    expect(h.harness.logEntries.filter(entry => entry.message.startsWith("recent-query "))).toHaveLength(1);
  });
  it("does not share a worker across different searches or cursors", async () => {
    const h = await host();
    const [latest, search, older] = await Promise.all([
      h.harness.callRpc("recent_latest", {}),
      h.harness.callRpc("recent_latest", { search: "not-a-chat" }),
      h.harness.callRpc("recent_latest", { before: { threadId: "thr_synthetic", lastMessageAt: 100 } }),
    ]);
    expect(latest).toMatchObject({ rows: [{ threadId: "thr_synthetic" }] });
    expect(search).toMatchObject({ rows: [] }); expect(older).toMatchObject({ rows: [] });
    expect(h.harness.logEntries.filter(entry => entry.message.startsWith("recent-query "))).toHaveLength(3);
    for (const input of [{ search: "a".repeat(501) }, { before: { lastMessageAt: 100 } }, { threadIds: Array(51).fill("thr_synthetic") }])
      await expect(h.harness.callRpc("recent_latest", input)).rejects.toThrow();
    expect(h.harness.logEntries.filter(entry => entry.message.startsWith("recent-query "))).toHaveLength(3);
  });
  it("does not reuse an in-flight snapshot after a persisted-data invalidation", async () => {
    const h = await host();
    const first = h.harness.callRpc("recent_latest", {}).then(result => ({ result }), error => ({ error }));
    await vi.waitFor(() => expect(h.subscribe).toHaveBeenCalled());
    const args = h.harness.sdk.callsTo("subscribe").find(call => (call[0] as { event: string }).event === "thread:changed")![0] as { callback(event: unknown): void };
    args.callback({ changes: ["events-appended"] });
    const second = h.harness.callRpc("recent_latest", {});
    await Promise.all([first, second]);
    expect(h.harness.logEntries.filter(entry => entry.message.startsWith("recent-query "))).toHaveLength(2);
  });
  it("cancelling one reader keeps the shared worker alive for another", async () => {
    const h = await host(); const abort = new AbortController();
    const a = h.harness.callRpc("recent_latest", {}, { signal: abort.signal }).catch(() => "cancelled");
    const b = h.harness.callRpc("recent_latest", {});
    abort.abort(); expect(await a).toBe("cancelled");
    expect(await b).toMatchObject({ rows: [{ threadId: "thr_synthetic", lastMessageAt: 100 }] });
    expect(h.harness.logEntries.filter(entry => entry.message.startsWith("recent-query "))).toHaveLength(1);
  });
  it("returns the validated result without waiting for worker teardown", async () => {
    const h = await host(true);
    writeFileSync(join(h.dir, "lib/recent/query-worker.mjs"), `process.send({phase:'finished',queryMs:1,wallMs:1,cpuMs:1});
      process.send({phase:'result',result:{rows:[],nextCursor:null,queryMs:1}});setInterval(()=>{},1000);`);
    expect(await h.harness.callRpc("recent_latest", {})).toEqual({ rows: [], nextCursor: null, queryMs: 1 });
    expect(h.harness.logEntries.some(entry => entry.message.startsWith("recent-worker-exit "))).toBe(false);
    await h.harness.dispose();
  });
  it("rejects a result without successful query telemetry and a result-less exit", async () => {
    const h = await host(true);
    writeFileSync(join(h.dir, "lib/recent/query-worker.mjs"), `process.send({phase:'result',result:{rows:[],queryMs:1}});`);
    await expect(h.harness.callRpc("recent_latest", {})).rejects.toThrow();
    writeFileSync(join(h.dir, "lib/recent/query-worker.mjs"), `// no result`);
    await expect(h.harness.callRpc("recent_latest", {})).rejects.toThrow();
  });
  it("invalid IPC telemetry fails closed without logging its payload", async () => {
    const h = await host(true);
    writeFileSync(join(h.dir, "lib/recent/query-worker.mjs"), `process.send({phase:'opened',openMs:1,secret:'synthetic-private-payload'});setInterval(()=>{},1000);`);
    await expect(h.harness.callRpc("recent_latest", {})).rejects.toThrow();
    const lines = h.harness.logEntries.map(entry => entry.message).join("\n");
    expect(lines).toContain('"reason":"invalid-output"');
    expect(lines).not.toContain("synthetic-private-payload"); expect(lines).not.toContain("secret");
  });
  it("keeps the real 8-second wall deadline and kills a stalled child process", async () => {
    const h = await host(true);
    await expect(h.harness.callRpc("recent_latest", {})).rejects.toThrow();
    expect(h.harness.logEntries.some(entry => entry.message.startsWith("recent-query ") && entry.message.includes('"reason":"timeout"'))).toBe(true);
    await vi.waitFor(() => expect(h.harness.logEntries.some(entry => entry.message.startsWith("recent-worker-exit ") && entry.message.includes('"activeWorkers":0'))).toBe(true), { timeout: 2000 });
  }, 15000);
  it.each(["abort", "dispose"])("%s действительно завершает owned worker, не только игнорирует ответ", async action => {
    const h = await host(true); const abort = new AbortController();
    const result = h.harness.callRpc("recent_latest", {}, { signal: abort.signal }).then(() => "unexpected", () => "cancelled");
    await vi.waitFor(() => expect(existsSync(h.pidFile)).toBe(true), { timeout: 6000 });
    if (action === "abort") abort.abort(); else await h.harness.dispose();
    expect(await result).toBe("cancelled");
    if (action === "abort") await vi.waitFor(() => expect(h.harness.logEntries.some(entry =>
      entry.message.startsWith("recent-worker-exit ") && entry.message.includes('"activeWorkers":0'))).toBe(true), { timeout: 2000 });
    const heartbeat = readFileSync(h.pidFile, "utf8");
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(readFileSync(h.pidFile, "utf8")).toBe(heartbeat);
  });
});
