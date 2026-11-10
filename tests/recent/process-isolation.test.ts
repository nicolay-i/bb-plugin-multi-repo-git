import { Worker } from "node:worker_threads";
import { fork } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const workerPath = resolve("lib/recent/query-worker.mjs");

describe("Recent SQLite process isolation", () => {
  it("refuses worker_threads before opening the database", async () => {
    mkdirSync(".tmp", { recursive: true });
    const dir = mkdtempSync(resolve(".tmp/recent-thread-guard-"));
    const database = join(dir, "must-not-open.db");
    try {
      const worker = new Worker(workerPath, { workerData: { database }, argv: [database], stdout: true, stderr: true });
      worker.stdout.resume(); worker.stderr.resume();
      const error = await new Promise<Error>(resolve => worker.once("error", resolve));
      expect(error.message).toContain("requires a separate process");
      await worker.terminate();
      expect(existsSync(database)).toBe(false);
      expect(existsSync(database + "-shm")).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("reads in child processes while the native driver writes and keeps WAL mapped", async () => {
    mkdirSync(".tmp", { recursive: true });
    const dir = mkdtempSync(resolve(".tmp/recent-mixed-wal-"));
    const path = join(dir, "fixture.db");
    const db = new Database(path);
    let reader: Database.Database | undefined;
    let writes = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    const children = new Set<ReturnType<typeof fork>>();
    try {
      db.pragma("journal_mode=WAL");
      db.exec(`CREATE TABLE threads(id TEXT PRIMARY KEY,visibility TEXT,archived_at INTEGER,deleted_at INTEGER);
        CREATE TABLE events(id TEXT PRIMARY KEY,thread_id TEXT,sequence INTEGER,created_at INTEGER,type TEXT,item_kind TEXT,parent_tool_call_id TEXT,data TEXT);
        CREATE INDEX events_thread_type_sequence_idx ON events(thread_id,type,sequence);
        CREATE INDEX events_thread_type_item_kind_sequence_idx ON events(thread_id,type,item_kind,sequence);
        CREATE INDEX events_completed_item_truncation_idx ON events(item_kind,created_at,id) WHERE type='item/completed';`);
      const insertThread = db.prepare("INSERT INTO threads VALUES(?,'visible',NULL,NULL)");
      const insert = db.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,NULL,?)");
      for (let i = 0; i < 80; i++) {
        const id = `thr_${String(i).padStart(3, "0")}`;
        insertThread.run(id);
        insert.run(`event_${i}`, id, 1, 1000 + i, "item/completed", "agentMessage", JSON.stringify({ item: { type: "agentMessage", text: "Synthetic WAL test" } }));
      }
      reader = new Database(path, { readonly: true, fileMustExist: true });
      reader.exec("BEGIN"); reader.prepare("SELECT count(*) FROM events").get();
      const shm = statSync(path + "-shm");
      const write = () => {
        writes++;
        insert.run(`write_${writes}`, "thr_000", writes + 1, 100000 + writes, "client/turn/requested", null, JSON.stringify({ initiator: "user", input: [{ type: "text", text: "Synthetic concurrent write" }] }));
      };
      write(); timer = setInterval(write, 5);
      let before: { threadId: string; lastMessageAt: number } | null = null;
      for (let i = 0; i < 8; i++) {
        const paged = i % 2 === 1;
        let result: { rows: { threadId: string; lastMessageAt: number }[]; nextCursor: { threadId: string; lastMessageAt: number } | null } | undefined;
        let pid: number | undefined;
        const child = fork(workerPath, [path], { stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: ["--no-warnings"] });
        children.add(child);
        await new Promise<void>((resolve, reject) => {
          const budget = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Child reader stalled")); }, 8000);
          child.on("error", reject);
          child.on("message", (message: any) => {
            if (message.phase === "opened") { pid = message.pid; child.send(paged ? { before } : {}); }
            if (message.phase === "result") result = message.result;
          });
          child.on("close", code => { clearTimeout(budget); children.delete(child); code === 0 ? resolve() : reject(new Error("Reader failed")); });
        });
        expect(pid).toBe(child.pid); expect(pid).not.toBe(process.pid);
        expect(result?.rows).toHaveLength(paged ? 30 : 50);
        if (paged) expect(result?.rows.some(row => row.threadId === "thr_000")).toBe(false);
        else { expect(result?.rows[0]?.threadId).toBe("thr_000"); before = result!.nextCursor; }
        expect(statSync(path + "-shm").ino).toBe(shm.ino);
        expect(statSync(path + "-shm").size).toBeGreaterThanOrEqual(shm.size);
        expect(reader.prepare("SELECT count(*) n FROM events").get()).toEqual({ n: 80 });
        expect((db.prepare("SELECT count(*) n FROM events").get() as { n: number }).n).toBe(80 + writes);
        db.pragma("wal_checkpoint(PASSIVE)");
      }
      expect(writes).toBeGreaterThan(8);
    } finally {
      if (timer) clearInterval(timer);
      await Promise.all([...children].map(child => new Promise<void>(resolve => { child.once("close", () => resolve()); child.kill("SIGKILL"); })));
      reader?.close(); db.close(); rmSync(dir, { recursive: true, force: true });
    }
  }, 90000);
});
