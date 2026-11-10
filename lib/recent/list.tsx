import { memo, useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { experimental_Icon as Icon, ThreadTitle,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph, experimental_ThreadActionsMenu as ThreadActionsMenu,
  experimental_ThreadActionsContextMenu as ThreadActionsContextMenu, experimental_useSidebarThreadSplit,
  experimental_useSidebarThreads, useSidebarThreadRowStatus, useSidebarThreadDraft, useSidebarThreadShortcut, useBbNavigate, useSdk,
  type PluginSidebarThread, type PluginThreadListProps,
  type PluginThreadActionTarget } from "@get-bb/plugin-sdk/app";
import { RecentController, type RecentState } from "./recent-controller.js";
import { workingThreadIds } from "./work-status.js";
import { usePluginStylesheet } from "../../stylesheet.js";


const buttonClass = "rounded-md border border-sidebar-border px-2 py-1 text-xs hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50";

const RecentRow = memo(function RecentRow({ thread, project, at, active, working, top, onMenuChange, onNavigate }: {
  thread: PluginSidebarThread; project: string; at: number; active: boolean; working: boolean; top: number; onMenuChange(id: string | null): void; onNavigate(): void;
}) {
  const navigate = useBbNavigate();
  const rowStatus = useSidebarThreadRowStatus(thread.id);
  const { hasUnsubmittedDraft } = useSidebarThreadDraft(thread.id);
  const indicator = hasUnsubmittedDraft && thread.indicator !== "unread-error" && thread.indicator !== "waiting-for-input"
    ? working ? "working-draft" : thread.indicator === "none" ? "draft" : thread.indicator : thread.indicator;
  const workIsHidden = working && ["none", "draft", "unread-success", "unread-error"].includes(indicator);
  const shortcut = useSidebarThreadShortcut(thread.id);
  const split = experimental_useSidebarThreadSplit(thread.id);
  const target: PluginThreadActionTarget = { id: thread.id, projectId: thread.projectId,
    parentThreadId: thread.parentThreadId, parentNotifications: thread.parentNotifications,
    archivedAt: thread.archivedAt, pinnedAt: thread.pinnedAt, sectionId: thread.sectionId,
    isUnread: thread.isUnread, status: thread.status, environment: thread.environment?.id == null ? null
      : { id: thread.environment.id, path: thread.environment.path } };
  const date = new Date(at);
  const fullDate = date.toLocaleString();
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (split.isAvailable && (event.metaKey || event.ctrlKey)) {
      event.preventDefault(); navigate.toThread(thread.id, { split: true }); return;
    }
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); navigate.toThread(thread.id); onNavigate();
  };
  const menuChanged = (open: boolean) => onMenuChange(open ? thread.id : null);
  return <ThreadActionsContextMenu thread={target} onOpenChange={menuChanged}>
    <li data-atrium-recent-row="" style={{ position: "absolute", top, left: 0, right: 0, height: 40 }} className={`flex min-w-0 items-center rounded-md focus-within:bg-sidebar-accent hover:bg-sidebar-accent ${active ? "bg-sidebar-accent text-sidebar-accent-foreground" : ""}`}>
      <a href={thread.href} onClick={open} {...split.splitProps} draggable={false}
        data-sidebar-thread-shortcut-target="" data-sidebar-thread-id={thread.id}
        aria-current={active ? "page" : undefined} aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
        aria-label={`${thread.displayTitle}, ${project}, ${fullDate}${thread.isUnread ? ", Unread" : ""}${working ? ", Work in progress" : ""}`}
        className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-0.5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
        <span className="flex size-4 shrink-0 items-center justify-center" title={workIsHidden ? "Work in progress" : thread.indicatorLabel ?? undefined}>
          <ThreadStatusGlyph indicator={workIsHidden ? "runtime" : indicator} rowStatus={rowStatus} size="compact" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1">
            <span className={`bb-thread-title min-w-0 truncate text-sm leading-5 ${thread.isUnread ? "font-semibold" : "font-normal"}`}><ThreadTitle threadId={thread.id} /></span>
            {working && thread.isUnread ? <span className="flex size-4 shrink-0 items-center justify-center" title={thread.indicator === "unread-error" ? thread.indicatorLabel ?? "Unread error" : "Unread"}>
              <ThreadStatusGlyph indicator={thread.indicator === "unread-error" ? "unread-error" : "unread-success"} size="compact" />
            </span> : null}
          </span>
          <span className="block truncate text-xs leading-4 text-muted-foreground">{project}</span>
        </span>
        {shortcut ? <kbd className="shrink-0 rounded border border-sidebar-border px-1 text-xs">{shortcut.label}</kbd> :
          <time dateTime={date.toISOString()} title={fullDate} aria-label={fullDate}
            className="shrink-0 text-right text-[10px] leading-3.5 tabular-nums text-muted-foreground">
            <span className="block">{date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            <span className="block">{date.toLocaleDateString()}</span>
          </time>}
      </a>
      <ThreadActionsMenu thread={target} onOpenChange={menuChanged} trigger={props => <button {...props} type="button"
        aria-label={`Actions: ${thread.displayTitle}`} title="Chat actions"
        className={`${props.className ?? ""} mr-1 flex size-7 shrink-0 items-center justify-center rounded-md border border-transparent bg-transparent text-muted-foreground hover:border-sidebar-border hover:bg-sidebar-accent hover:text-sidebar-foreground hover:shadow-xs data-[state=open]:border-sidebar-border data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-foreground data-[state=open]:shadow-xs focus-visible:outline-2 focus-visible:outline-ring`}>
        <Icon name="MoreHorizontal" className="size-4" />
      </button>} />
    </li>
  </ThreadActionsContextMenu>;
});

function scrollRoot(node: HTMLElement): HTMLElement | null {
  for (let parent = node.parentElement; parent; parent = parent.parentElement)
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) return parent;
  return null;
}

export function RecentThreadList({ activeThreadId, onNavigate }: PluginThreadListProps) {
  usePluginStylesheet();
  const sdk = useSdk();
  const sidebar = experimental_useSidebarThreads();
  const [state, setState] = useState<RecentState>({ status: "loading", rows: [] });
  const [query, setQuery] = useState("");
  const controller = useRef<RecentController | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ first: 0, last: 24 });
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  useEffect(() => {
    const current = new RecentController(sdk, setState);
    controller.current = current; current.start();
    return () => { current.dispose(); controller.current = null; };
  }, [sdk]);
  const threads = new Map(sidebar.threads.map(thread => [thread.id, thread]));
  const working = workingThreadIds(threads);
  const projects = new Map(sidebar.projects.map(project => [project.id, project.name]));
  const retry = () => controller.current?.retry();
  const metadataMissing = (state.status === "ready" || state.status === "refreshing") && state.rows.some(row => {
    const thread = threads.get(row.threadId);
    return !thread || thread.isArchived || thread.isHidden || !projects.has(thread.projectId);
  });
  const error = state.status === "error" ? state.message : sidebar.status === "error"
    ? "Could not load BB thread details." : metadataMissing && sidebar.status !== "loading"
      ? "Thread details changed. Refresh the list." : null;
  const loading = !error && (state.status === "loading" || sidebar.status === "loading");
  const refreshing = !loading && !error && state.status === "refreshing";
  const search = query.trim();
  useEffect(() => { controller.current?.setSearch(query); }, [query]);
  useEffect(() => {
    const element = list.current;
    if (!element) return;
    const root = scrollRoot(element);
    let frame = 0;
    const measure = () => {
      const top = (root?.getBoundingClientRect().top ?? 0) - element.getBoundingClientRect().top;
      const height = root?.clientHeight ?? window.innerHeight;
      const first = Math.max(0, Math.floor(top / 42) - 8);
      const last = Math.max(first, Math.ceil((top + height) / 42) + 8);
      setRange(previous => previous.first === first && previous.last === last ? previous : { first, last });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure(); }); };
    const observer = new ResizeObserver(schedule);
    observer.observe(root ?? document.documentElement); observer.observe(element);
    (root ?? window).addEventListener("scroll", schedule, { passive: true });
    measure();
    return () => {
      observer.disconnect(); (root ?? window).removeEventListener("scroll", schedule); cancelAnimationFrame(frame);
    };
  }, [state.rows.length, loading, error]);
  useEffect(() => {
    if (!end.current || !state.hasMore || state.loadingMore || state.pageError || loading || refreshing || error) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) controller.current?.loadMore();
    }, { root: scrollRoot(end.current), rootMargin: "0px 0px 240px 0px" });
    observer.observe(end.current);
    return () => observer.disconnect();
  }, [state.hasMore, state.loadingMore, state.pageError, state.rows.length, loading, refreshing, error]);
  const windowed = state.rows.flatMap((row, index) =>
    index >= range.first && index < range.last || row.threadId === focusedId || row.threadId === menuId ? [{ row, index }] : []);
  return <section aria-label="Recent chats" data-recent-chats-sidebar="" aria-busy={loading || refreshing || !!state.loadingMore} data-state={error ? "error" : loading ? "loading" : refreshing ? "refreshing" : "ready"}
    className="min-w-0 pl-2 pb-2 text-sidebar-foreground">
    <header className="sticky top-0 z-10 mb-1 flex min-w-0 items-center gap-1 bg-sidebar pr-2 py-1">
      <label className="relative min-w-0 flex-1">
        <Icon name="Search" className="pointer-events-none absolute left-2 top-2 size-4 text-muted-foreground" />
        <input type="search" aria-label="Search recent chats" title="Search chat titles and project names across all active chats"
          placeholder="Search all chats…" maxLength={500} value={query} onChange={event => {
            const root = list.current && scrollRoot(list.current);
            if (root) root.scrollTop = 0;
            setQuery(event.target.value);
          }}
          className="h-8 w-full min-w-0 rounded-md border border-sidebar-border bg-transparent pl-7 pr-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" />
      </label>
      <button type="button" onClick={retry} disabled={loading || refreshing} aria-label="Refresh recent chats" title={refreshing ? "Updating recent chats…" : "Refresh recent chats"}
        className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"><Icon name="ArrowReloadHorizontal" className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} /></button>
      {refreshing ? <span role="status" className="sr-only">Updating recent chats…</span> : null}
    </header>
    {error ? <div role="alert" className="space-y-2 rounded-md border border-sidebar-border p-2 text-xs">
      <p className="text-destructive">{error}</p>
      <p className="text-muted-foreground">The list could not be verified.</p>
      <button type="button" onClick={retry} className={buttonClass}>Retry</button>
    </div> : loading ? <p role="status" className="px-2 py-4 text-xs text-muted-foreground">Loading recent chats…</p>
      : state.rows.length === 0 ? <p role="status" className="px-2 py-4 text-xs text-muted-foreground">{search ? "No chats match your search." : "No chats with saved messages yet."}</p>
        : <>
          <ul ref={list} aria-label="Recent conversations" className="relative m-0 list-none p-0"
            style={{ height: state.rows.length * 42 - 2 }}
            onFocusCapture={event => setFocusedId((event.target as HTMLElement).closest<HTMLElement>("[data-sidebar-thread-id]")?.dataset.sidebarThreadId ?? null)}
            onBlurCapture={event => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedId(null);
            }}>
            {windowed.map(({ row, index }) => {
              const thread = threads.get(row.threadId)!;
              return <RecentRow key={thread.id} thread={thread} project={projects.get(thread.projectId)!}
                at={row.lastMessageAt} top={index * 42} onMenuChange={setMenuId} active={thread.id === activeThreadId} working={working.has(thread.id)} onNavigate={onNavigate} />;
            })}
          </ul>
          <div ref={end} role="status" className="px-2 py-3 text-xs text-muted-foreground">
            {state.pageError ? <><p>{state.pageError}</p><button type="button" className={buttonClass}
              onClick={() => controller.current?.loadMore(true)}>Retry loading more</button></>
              : state.loadingMore ? "Loading more chats…" : !state.hasMore ? search ? "All matching chats loaded." : "All chats loaded." : null}
          </div>
        </>}
  </section>;
}


