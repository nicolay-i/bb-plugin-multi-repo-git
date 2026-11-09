import { MESSAGE_TYPES, type RecentRow, type Sdk } from "./data";
import { latestSchema } from "./schema";

export type RecentState =
  | { status: "loading"; rows: readonly RecentRow[] }
  | { status: "ready"; rows: readonly RecentRow[] }
  | { status: "refreshing"; rows: readonly RecentRow[] }
  | { status: "error"; rows: readonly RecentRow[]; message: string };

const METADATA_ONLY = new Set(["read-state-changed", "title-changed", "pin-state-changed", "tabs-changed",
  "terminals-changed", "status-changed", "queue-changed", "interactions-changed"]);

export class RecentController {
  private readonly lifetime = new AbortController();
  private readonly cleanup: (() => void)[] = [];
  private request?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private connected = false;
  private hasConnected = false;
  private pending = false;
  private running = false;
  private failed = false;
  private revision = 0;
  private snapshot: readonly RecentRow[] | null = null;

  constructor(private readonly sdk: Sdk, private readonly changed: (state: RecentState) => void) {}

  start(): void {
    if (this.cleanup.length || this.lifetime.signal.aborted) return;
    this.emit({ status: "loading", rows: [] });
    this.cleanup.push(this.sdk.subscribe({ event: "realtime:connection", callback: event => {
      this.connected = event.state === "connected";
      if (this.connected) { this.hasConnected = true; this.retry(); }
      else {
        this.revision++; this.request?.abort();
        if (event.state === "connecting" && !this.hasConnected) this.emit({ status: "loading", rows: [] });
        else this.emit({ status: "error", rows: [], message: "Disconnected from BB. The list could not be verified." });
      }
    } }));
    this.cleanup.push(this.sdk.subscribe({ event: "thread:changed", callback: event => {
      if (event.changes.length && event.changes.every(kind => METADATA_ONLY.has(kind))) return;
      const append = event.changes.includes("events-appended") &&
        event.changes.every(kind => kind === "events-appended" || METADATA_ONLY.has(kind));
      if (append && event.metadata?.eventTypes?.length &&
          !event.metadata.eventTypes.some(type => (MESSAGE_TYPES as readonly string[]).includes(type))) return;
      if (append) {
        // An exact snapshot may be published while new appends queue another
        // refresh. Otherwise continuous tool completions starve initial ready.
        this.pending = true;
        // A failed request must not permanently suppress later data updates.
        // Recover only on a new relevant event; no polling or retry timer loop.
        if (this.failed) {
          this.failed = false;
          this.emit({ status: "loading", rows: [] });
        }
        if (this.connected) this.schedule(1000);
      } else {
        // Remove known unavailable rows immediately; retain the remaining snapshot
        // visibly marked as updating rather than replacing the whole list.
        if (event.changes.some(kind => kind === "thread-deleted" || kind === "archived-changed")) {
          this.snapshot = event.id ? this.snapshot?.filter(row => row.threadId !== event.id) ?? null : null;
        }
        this.retry(); // Destructive/unknown changes still invalidate in-flight requests.
      }
    } }));
    this.cleanup.push(this.sdk.subscribe({ event: "project:changed", callback: event => {
      if (event.changes.length && event.changes.every(kind => ["project-updated", "project-sources-changed", "project-order-changed", "threads-changed"].includes(kind))) return;
      this.retry();
    } }));
  }

  retry = (): void => {
    if (this.lifetime.signal.aborted) return;
    this.failed = false; this.pending = true; this.revision++;
    this.request?.abort();
    this.emit(this.snapshot ? { status: "refreshing", rows: this.snapshot } : { status: "loading", rows: [] });
    if (this.connected) this.schedule(0);
  };

  dispose(): void {
    this.lifetime.abort(); this.request?.abort();
    if (this.timer !== undefined) clearTimeout(this.timer);
    for (const off of this.cleanup.splice(0).reverse()) off();
  }

  private emit(state: RecentState): void {
    if (!this.lifetime.signal.aborted) {
      if (state.status === "ready") this.snapshot = state.rows;
      else if (state.status === "error" || state.status === "loading") this.snapshot = null;
      this.changed(state);
    }
  }

  private schedule(delay: number): void {
    if (this.running || this.timer !== undefined || this.lifetime.signal.aborted) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.drain(); }, delay);
  }

  private async drain(): Promise<void> {
    if (this.running || !this.pending || !this.connected || this.failed || this.lifetime.signal.aborted) return;
    this.running = true; this.pending = false;
    const epoch = this.revision;
    const request = this.request = new AbortController();
    if (this.snapshot) this.emit({ status: "refreshing", rows: this.snapshot });
    try {
      const result = await this.sdk.plugins.callRpc({ pluginId: "multi-repo-git", method: "recent_latest", input: {},
        outputSchema: latestSchema, signal: request.signal });
      if (epoch === this.revision && this.connected && !request.signal.aborted)
        this.emit({ status: "ready", rows: result.rows });
    } catch {
      if (this.lifetime.signal.aborted) return;
      if (epoch === this.revision && this.connected && !request.signal.aborted) {
        this.failed = true;
        this.emit({ status: "error", rows: [], message: "Could not load recent chats. Retry using Refresh." });
      }
    } finally {
      this.running = false;
      if (this.request === request) this.request = undefined;
      if (this.pending && this.connected && !this.failed) this.schedule(epoch === this.revision ? 1000 : 0);
    }
  }
}
