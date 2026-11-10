import { MESSAGE_TYPES, type RecentRow, type Sdk } from "./data";
import { latestSchema, type RecentCursor } from "./schema";

type PageFlags = { hasMore?: boolean; loadingMore?: boolean; pageError?: string };
export type RecentState = PageFlags & (
  | { status: "loading" | "ready" | "refreshing"; rows: readonly RecentRow[] }
  | { status: "error"; rows: readonly RecentRow[]; message: string });

const METADATA_ONLY = new Set(["read-state-changed", "title-changed", "pin-state-changed", "tabs-changed",
  "terminals-changed", "status-changed", "queue-changed", "interactions-changed"]);
const compare = (a: RecentRow, b: RecentRow) => b.lastMessageAt - a.lastMessageAt ||
  (a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0);

export class RecentController {
  private readonly lifetime = new AbortController();
  private readonly cleanup: (() => void)[] = [];
  private readonly changedIds = new Set<string>();
  private request?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private connected = false;
  private hasConnected = false;
  private pending = false;
  private running = false;
  private failed = false;
  private pageFailed = false;
  private full = true;
  private more = false;
  private revision = 0;
  private search = "";
  private cursor: RecentCursor | null = null;
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
      if (event.changes.length && event.changes.every(kind => METADATA_ONLY.has(kind))) {
        if (this.search && event.changes.includes("title-changed")) this.retry();
        return;
      }
      const append = event.changes.includes("events-appended") &&
        event.changes.every(kind => kind === "events-appended" || METADATA_ONLY.has(kind));
      if (append && event.metadata?.eventTypes?.length &&
          !event.metadata.eventTypes.some(type => (MESSAGE_TYPES as readonly string[]).includes(type))) return;
      if (append && event.id) {
        // Revalidate the changed IDs, not every historical page on every message.
        this.changedIds.add(event.id); this.pending = true;
        if (this.failed) { this.failed = false; this.emit({ status: "loading", rows: [] }); }
        if (this.connected) this.schedule(1000);
      } else {
        if (event.changes.some(kind => kind === "thread-deleted" || kind === "archived-changed"))
          this.snapshot = event.id ? this.snapshot?.filter(row => row.threadId !== event.id) ?? null : null;
        this.retry();
      }
    } }));
    this.cleanup.push(this.sdk.subscribe({ event: "project:changed", callback: event => {
      if (event.changes.length && event.changes.every(kind => ["project-updated", "project-sources-changed", "project-order-changed", "threads-changed"].includes(kind)) &&
          !(this.search && event.changes.includes("project-updated"))) return;
      this.retry();
    } }));
  }

  setSearch(value: string): void {
    const search = value.trim();
    if (search.toLowerCase() === this.search.toLowerCase() || this.lifetime.signal.aborted) return;
    this.search = search; this.snapshot = null; this.cursor = null;
    this.retry();
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.connected) this.schedule(250);
  }

  retry = (): void => {
    if (this.lifetime.signal.aborted) return;
    this.failed = false; this.pageFailed = false; this.pending = true; this.full = true; this.more = false; this.revision++;
    this.changedIds.clear(); this.request?.abort();
    this.emit(this.snapshot ? { status: "refreshing", rows: this.snapshot } : { status: "loading", rows: [] });
    if (this.connected) this.schedule(0);
  };

  loadMore = (retry = false): void => {
    if (!this.connected || this.running || this.pending || this.failed || this.pageFailed && !retry || !this.cursor || this.lifetime.signal.aborted) return;
    this.pageFailed = false; this.more = true; this.schedule(0);
  };

  dispose(): void {
    this.lifetime.abort(); this.request?.abort();
    if (this.timer !== undefined) clearTimeout(this.timer);
    for (const off of this.cleanup.splice(0).reverse()) off();
  }

  private emit(state: RecentState): void {
    if (this.lifetime.signal.aborted) return;
    if (state.status === "ready") this.snapshot = state.rows;
    else if (state.status === "error" || state.status === "loading") { this.snapshot = null; this.cursor = null; }
    this.changed(state);
  }

  private ready(rows: readonly RecentRow[], flags: PageFlags = {}): void {
    this.emit({ status: "ready", rows, ...(this.cursor ? { hasMore: true } : {}),
      ...(this.pageFailed ? { pageError: "Could not load more chats." } : {}), ...flags });
  }

  private schedule(delay: number): void {
    if (this.running || this.timer !== undefined || this.lifetime.signal.aborted) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.drain(); }, delay);
  }

  private async drain(): Promise<void> {
    if (this.running || (!this.pending && !this.more) || !this.connected || this.failed || this.lifetime.signal.aborted) return;
    this.running = true;
    const mode = this.full || !this.snapshot ? "full" : this.pending ? "changes" : "more";
    const ids = [...this.changedIds].slice(0, 50);
    for (const id of ids) this.changedIds.delete(id);
    this.pending = this.changedIds.size > 0; this.full = false; this.more = false;
    const epoch = this.revision, previous = this.snapshot;
    const request = this.request = new AbortController();
    const current = () => epoch === this.revision && this.connected && !request.signal.aborted;
    const fetch = (extra: { before?: RecentCursor; threadIds?: string[] } = {}) => this.sdk.plugins.callRpc({
      pluginId: "multi-repo-git", method: "recent_latest", input: { ...(this.search ? { search: this.search } : {}), ...extra },
      outputSchema: latestSchema, signal: request.signal });
    if (previous) {
      if (mode === "more") this.ready(previous, { loadingMore: true });
      else this.emit({ status: "refreshing", rows: previous });
    }
    try {
      if (mode === "full") {
        // Explicit refresh preserves the loaded extent. Publish atomically;
        // destructive events abort the whole refresh, including its later pages.
        const rows = new Map<string, RecentRow>();
        let before: RecentCursor | undefined;
        let next: RecentCursor | null;
        do {
          const result = await fetch(before ? { before } : {});
          if (!current()) return;
          for (const row of result.rows) rows.set(row.threadId, row);
          next = result.nextCursor; before = next ?? undefined;
        } while (next && rows.size < Math.max(50, previous?.length ?? 0));
        this.cursor = next;
        this.ready([...rows.values()].sort(compare));
      } else {
        const result = await fetch(mode === "more" ? { before: this.cursor! } : { threadIds: ids });
        if (!current()) return;
        const rows = new Map(previous!.filter(row => mode !== "changes" || !ids.includes(row.threadId)).map(row => [row.threadId, row]));
        for (const row of result.rows) {
          if (mode === "more" || previous!.some(old => old.threadId === row.threadId) || !this.cursor || compare(row, this.cursor) <= 0)
            rows.set(row.threadId, row);
        }
        if (mode === "more") this.cursor = result.nextCursor;
        this.ready([...rows.values()].sort(compare));
      }
    } catch {
      if (!current() || this.lifetime.signal.aborted) return;
      if (mode === "more") { this.pageFailed = true; this.ready(previous!); }
      else {
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
