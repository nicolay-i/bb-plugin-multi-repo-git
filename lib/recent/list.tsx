import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { experimental_Icon as Icon, ThreadTitle,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph, experimental_ThreadActionsMenu as ThreadActionsMenu,
  experimental_ThreadActionsContextMenu as ThreadActionsContextMenu, experimental_useSidebarThreadSplit,
  experimental_useSidebarThreads, useSidebarThreadRowStatus, useSidebarThreadDraft, useSidebarThreadShortcut, useBbNavigate, useSdk,
  type PluginSidebarThread, type PluginThreadListProps,
  type PluginThreadActionTarget } from "@get-bb/plugin-sdk/app";
import { RecentController, type RecentState } from "./recent-controller.js";
import { usePluginStylesheet } from "../../stylesheet.js";


const buttonClass = "rounded-md border border-sidebar-border px-2 py-1 text-xs hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50";

function RecentRow({ thread, project, at, active, onNavigate }: {
  thread: PluginSidebarThread; project: string; at: number; active: boolean; onNavigate(): void;
}) {
  const navigate = useBbNavigate();
  const rowStatus = useSidebarThreadRowStatus(thread.id);
  const { hasUnsubmittedDraft } = useSidebarThreadDraft(thread.id);
  const working = ["active", "provisioning", "starting", "stopping"].includes(thread.runtimeStatus)
    || Object.values(thread.activity).some(count => count > 0);
  const indicator = hasUnsubmittedDraft && thread.indicator !== "unread-error" && thread.indicator !== "waiting-for-input"
    ? working ? "working-draft" : thread.indicator === "none" ? "draft" : thread.indicator : thread.indicator;
  const unreadHidesWork = working && (indicator === "unread-success" || indicator === "unread-error");
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
  return <ThreadActionsContextMenu thread={target}>
    <li data-atrium-recent-row="" className={`flex min-w-0 items-center rounded-md focus-within:bg-sidebar-accent hover:bg-sidebar-accent ${active ? "bg-sidebar-accent text-sidebar-accent-foreground" : ""}`}>
      <a href={thread.href} onClick={open} {...split.splitProps} draggable={false}
        data-sidebar-thread-shortcut-target="" data-sidebar-thread-id={thread.id}
        aria-current={active ? "page" : undefined} aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
        aria-label={`${thread.displayTitle}, ${project}, ${fullDate}${thread.isUnread ? ", Unread" : ""}${working ? ", Work in progress" : ""}`}
        className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-0.5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
        <span className="flex size-4 shrink-0 items-center justify-center" title={unreadHidesWork ? "Work in progress" : thread.indicatorLabel ?? undefined}>
          <ThreadStatusGlyph indicator={unreadHidesWork ? "runtime" : indicator} rowStatus={rowStatus} size="compact" />
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
      <ThreadActionsMenu thread={target} trigger={props => <button {...props} type="button"
        aria-label={`Actions: ${thread.displayTitle}`} title="Chat actions"
        className={`${props.className ?? ""} mr-1 flex size-7 shrink-0 items-center justify-center rounded-md border border-transparent bg-transparent text-muted-foreground hover:border-sidebar-border hover:bg-sidebar-accent hover:text-sidebar-foreground hover:shadow-xs data-[state=open]:border-sidebar-border data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-foreground data-[state=open]:shadow-xs focus-visible:outline-2 focus-visible:outline-ring`}>
        <Icon name="MoreHorizontal" className="size-4" />
      </button>} />
    </li>
  </ThreadActionsContextMenu>;
}

export function RecentThreadList({ activeThreadId, onNavigate }: PluginThreadListProps) {
  usePluginStylesheet();
  const sdk = useSdk();
  const sidebar = experimental_useSidebarThreads();
  const [state, setState] = useState<RecentState>({ status: "loading", rows: [] });
  const [query, setQuery] = useState("");
  const controller = useRef<RecentController | null>(null);
  useEffect(() => {
    const current = new RecentController(sdk, setState);
    controller.current = current; current.start();
    return () => { current.dispose(); controller.current = null; };
  }, [sdk]);
  const threads = new Map(sidebar.threads.map(thread => [thread.id, thread]));
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
  const search = query.trim().toLocaleLowerCase();
  const visibleRows = state.rows.filter(row => !search ||
    `${threads.get(row.threadId)?.displayTitle ?? ""} ${projects.get(threads.get(row.threadId)?.projectId ?? "") ?? ""}`
      .toLocaleLowerCase().includes(search));
  return <section aria-label="Recent chats" data-recent-chats-sidebar="" aria-busy={loading || refreshing} data-state={error ? "error" : loading ? "loading" : refreshing ? "refreshing" : "ready"}
    className="min-w-0 pl-2 pb-2 text-sidebar-foreground">
    <header className="sticky top-0 z-10 mb-1 flex min-w-0 items-center gap-1 bg-sidebar pr-2 py-1">
      <label className="relative min-w-0 flex-1">
        <Icon name="Search" className="pointer-events-none absolute left-2 top-2 size-4 text-muted-foreground" />
        <input type="search" aria-label="Search recent chats" title="Search titles and projects in the latest 50 chats"
          placeholder="Search recent chats…" value={query} onChange={event => setQuery(event.target.value)}
          className="h-8 w-full min-w-0 rounded-md border border-sidebar-border bg-transparent pl-7 pr-2 text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" />
      </label>
      <button type="button" onClick={retry} disabled={loading || refreshing} aria-label="Refresh recent chats" title={refreshing ? "Updating recent chats…" : "Refresh recent chats"}
        className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"><Icon name="RefreshCw" className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} /></button>
      {refreshing ? <span role="status" className="sr-only">Updating recent chats…</span> : null}
    </header>
    {error ? <div role="alert" className="space-y-2 rounded-md border border-sidebar-border p-2 text-xs">
      <p className="text-destructive">{error}</p>
      <p className="text-muted-foreground">The list could not be verified.</p>
      <button type="button" onClick={retry} className={buttonClass}>Retry</button>
    </div> : loading ? <p role="status" className="px-2 py-4 text-xs text-muted-foreground">Loading recent chats…</p>
      : state.rows.length === 0 ? <p role="status" className="px-2 py-4 text-xs text-muted-foreground">No chats with saved messages yet.</p>
      : visibleRows.length === 0 ? <p role="status" className="px-2 py-3 text-xs text-muted-foreground">No recent chats match your search.</p>
        : <ul aria-label="Recent conversations" className="m-0 list-none space-y-0.5 p-0">
          {visibleRows.map(row => {
            const thread = threads.get(row.threadId)!;
            return <RecentRow key={thread.id} thread={thread} project={projects.get(thread.projectId)!}
              at={row.lastMessageAt} active={thread.id === activeThreadId} onNavigate={onNavigate} />;
          })}
        </ul>}
  </section>;
}


