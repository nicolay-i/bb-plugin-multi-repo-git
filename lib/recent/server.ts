import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { latestSchema, pageInputSchema, type PageInput } from "./schema.js";

export const rpcContract = defineRpcContract({
  recent_latest: { input: pageInputSchema, output: latestSchema },
});
const duration = z.number().finite().nonnegative().max(86400000);
const workerMessage = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("opened"), openMs: duration, pid: z.number().int().positive() }).strict(),
  z.object({ phase: z.literal("finished"), queryMs: duration, wallMs: duration, cpuMs: duration }).strict(),
  z.object({ phase: z.literal("failed"), queryStarted: z.boolean(), wallMs: duration, cpuMs: duration }).strict(),
  z.object({ phase: z.literal("result"), result: latestSchema }).strict(),
]);
type Result = z.infer<typeof latestSchema>;
type Failure = "aborted" | "timeout" | "spawn-error" | "worker-error" | "invalid-output";

export default function registerRecent(bb: BbPluginApi): void {
  let workerPath: string | undefined;
  const database = join(bb.server.experimental_dataDir, "bb.db");
  const workers = new Set<ChildProcess>();
  const subscriptions: (() => void)[] = [];
  let requestId = 0, maxWorkers = 0, revision = 0;
  let watching = false, disposed = false;
  const flights = new Map<string, { revision: number; controller: AbortController; promise: Promise<Result>; readers: number }>();
  bb.onDispose(async () => {
    disposed = true;
    for (const flight of flights.values()) flight.controller.abort();
    for (const off of subscriptions) off();
    await Promise.all([...workers].map(worker => new Promise<void>(resolve => {
      worker.once("close", () => resolve());
      worker.kill("SIGKILL");
    })));
  });

  async function execute(signal: AbortSignal, input: PageInput): Promise<Result> {
    if (signal.aborted || disposed) throw new Error("Request cancelled.");
    if (!workerPath) {
      const installed = (await bb.sdk.plugins.list()).plugins.find(plugin => plugin.id === bb.pluginId);
      if (!installed?.rootDir) throw new Error("Installed Atrium source not found.");
      workerPath = join(installed.rootDir, "lib", "recent", "query-worker.mjs");
    }
    if (signal.aborted || disposed) throw new Error("Request cancelled.");
    const started = performance.now(), id = ++requestId;
    // OS process isolation is required: node:sqlite must not share BB's process
    // with its independent native SQLite driver. Do not replace this with Worker.
    const worker = spawn(process.execPath, ["--no-warnings", workerPath, database], {
      stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
      env: { ...process.env, NODE_OPTIONS: "" }, // Do not inherit BB preloads into the isolated reader.
    });
    workers.add(worker); maxWorkers = Math.max(maxWorkers, workers.size);
    const activeAtStart = workers.size;
    return new Promise<Result>((resolve, reject) => {
      let settled = false, frames = 0;
      let workerSpawnedMs: number | null = null, workerStartedMs: number | null = null;
      let telemetry: Exclude<z.infer<typeof workerMessage>, { phase: "result" }> | null = null;
      const finish = (reason: Failure | null, result?: Result) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal.removeEventListener("abort", abort);
        if (!disposed) bb.log.info("recent-query " + JSON.stringify({ id, elapsedMs: Math.round(performance.now() - started),
          reason: reason ?? "success", activeAtStart, maxWorkersSinceReload: maxWorkers, workerPid: worker.pid, workerSpawnedMs, workerStartedMs, telemetry }));
        if (reason) reject(new Error("Could not load recent chats. Retry using Refresh."));
        else resolve(result!);
      };
      const cancel = (reason: Failure) => { worker.kill("SIGKILL"); finish(reason); };
      const abort = () => cancel("aborted");
      const timer = setTimeout(() => cancel("timeout"), 8000);
      signal.addEventListener("abort", abort, { once: true });
      worker.on("spawn", () => { workerSpawnedMs = Math.round(performance.now() - started); });
      worker.on("message", message => {
        if (settled) return;
        const parsed = workerMessage.safeParse(message);
        if (++frames > 3 || !parsed.success) { cancel("invalid-output"); return; }
        const frame = parsed.data;
        if (frame.phase === "result") {
          if (telemetry?.phase !== "finished") { cancel("invalid-output"); return; }
          // The worker closes its read snapshot before sending the validated result.
          // Do not wait for OS process teardown before returning the rows.
          finish(null, frame.result);
        } else {
          workerStartedMs ??= Math.round(performance.now() - started);
          if (frame.phase === "opened" && (frame.pid === process.pid || frame.pid !== worker.pid)) {
            cancel("invalid-output"); return;
          }
          telemetry = frame;
          if (frame.phase === "opened") worker.send(input, error => { if (error) cancel("worker-error"); });
          if (frame.phase === "failed") cancel("worker-error");
        }
      });
      worker.on("error", () => finish("spawn-error"));
      worker.on("close", code => {
        workers.delete(worker);
        if (!disposed) bb.log.info("recent-worker-exit " + JSON.stringify({ id, code, activeWorkers: workers.size }));
        finish("worker-error"); // A result-less exit is never an empty successful list.
      });
      if (signal.aborted) abort();
    });
  }

  bb.rpc.register(rpcContract, {
    recent_latest: (input, { experimental_signal: signal }) => {
      if (signal.aborted || disposed) return Promise.reject(new Error("Request cancelled."));
      if (!watching) {
        // Never share a snapshot across a persisted-data invalidation.
        subscriptions.push(bb.sdk.subscribe({ event: "thread:changed", callback: () => { revision++; } }));
        subscriptions.push(bb.sdk.subscribe({ event: "project:changed", callback: () => { revision++; } }));
        watching = true;
      }
      const key = JSON.stringify({ ...input, search: input.search.toLowerCase() });
      let current = flights.get(key);
      if (!current || current.revision !== revision || current.controller.signal.aborted) {
        const controller = new AbortController();
        current = { revision, controller, promise: execute(controller.signal, input), readers: 0 };
        flights.set(key, current);
        const entry = current;
        const clear = () => { if (flights.get(key) === entry) flights.delete(key); };
        void current.promise.then(clear, clear);
      }
      current.readers++;
      return new Promise<Result>((resolve, reject) => {
        let done = false;
        const finish = (error: unknown, result?: Result) => {
          if (done) return;
          done = true; signal.removeEventListener("abort", abort);
          if (--current.readers === 0) current.controller.abort();
          if (error) reject(error); else resolve(result!);
        };
        const abort = () => finish(new Error("Request cancelled."));
        signal.addEventListener("abort", abort, { once: true });
        void current.promise.then(result => finish(null, result), error => finish(error));
        if (signal.aborted) abort();
      });
    },
  });
}
