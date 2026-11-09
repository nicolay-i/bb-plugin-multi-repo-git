// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread, PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import { assistant, fixture, thread } from "./fixtures";

const slots: { lifecycle: { unmount(): void } }[] = [];
afterEach(() => { for (const slot of slots.splice(0)) slot.lifecycle.unmount(); vi.restoreAllMocks(); });
const sidebarThread = () => ({
  ...thread("thr_synthetic"), displayTitle: "Synthetic chat", href: "/projects/proj_synthetic/threads/thr_synthetic",
  indicator: "unread-success", indicatorLabel: "Unread", isUnread: true, isArchived: false, isHidden: false,
  environment: null, host: null, runtimeStatus: "idle", isPinned: false,
  activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
} as PluginSidebarThread);
async function page(f = fixture(), rows = [sidebarThread()],
  options: Parameters<typeof renderSlot>[2] = {}, props: Partial<PluginThreadListProps> = {}) {
  const app = await loadPluginApp(() => import("../../app.js"));
  const onNavigate = vi.fn();
  const slot = renderSlot(app.threadLists.find(item => item.id === "recent")!, {
    activeThreadId: "thr_synthetic", activeProjectId: "proj_synthetic", isCompactViewport: false,
    searchQuery: "", onNavigate, ...props,
  }, { ...options, sdk: { ...f.sdk, ...options.sdk }, sidebarThreads: { status: "ready", threads: rows,
    projects: [{ id: "proj_synthetic", name: "Synthetic project", isPersonal: false,
      href: "/projects/proj_synthetic", settingsHref: "/settings/projects/proj_synthetic" }] } });
  slots.push(slot);
  return { app, slot, f, onNavigate };
}

describe("Integrated Recent sidebar", () => {
  it("adds Recent and a top overlay, not a navigation replacement or footer switch", async () => {
    const { app } = await page();
    expect(app.threadLists).toHaveLength(1);
    expect(app.threadLists[0]).toMatchObject({ id: "recent", title: "Recent chats" });
    expect(app.appOverlays.map(item => item.id)).toContain("sidebar-view-switch");
    expect(app.experimentalSidebarFooterItems).toHaveLength(0);
    expect(app.navPanels).toHaveLength(0); expect(app.experimentalSidebarNavigations).toHaveLength(0);
  });
  it("renders host title, timestamp, status, active row and native shortcut attributes", async () => {
    const { slot } = await page(); const link = await slot.findByRole("link", { name: /Synthetic chat/ });
    expect(link.getAttribute("href")).toBe("/projects/proj_synthetic/threads/thr_synthetic");
    expect(link.querySelector('[data-thread-title="thr_synthetic"]')).not.toBeNull();
    expect(link.textContent).toContain("Synthetic project");
    expect(link.querySelector("time")?.getAttribute("dateTime")).toBe(new Date(200).toISOString());
    expect(link.querySelector('[data-thread-status-glyph="unread-success"]')?.parentElement?.classList.contains("flex")).toBe(true);
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(link.hasAttribute("data-sidebar-thread-shortcut-target")).toBe(true);
    expect(slot.queryByRole("main")).toBeNull();
  });
  it.each(["active", "provisioning", "starting", "stopping"] as const)("shows unread and %s work together", async runtimeStatus => {
    const { slot } = await page(fixture(), [{ ...sidebarThread(), runtimeStatus }]);
    const link = await slot.findByRole("link", { name: /Synthetic chat.*Unread.*Work in progress/ });
    expect(link.querySelector('[data-thread-status-glyph="runtime"]')).not.toBeNull();
    expect(link.querySelector('[data-thread-status-glyph="unread-success"]')).not.toBeNull();
    expect(link.querySelector(".bb-thread-title")?.classList.contains("font-semibold")).toBe(true);
  });
  it.each([false, true])("retains an unread badge when the host prioritizes work (draft=%s)", async draft => {
    const { slot } = await page(fixture(), [{ ...sidebarThread(), runtimeStatus: "active", indicator: "runtime" }],
      { sidebarDraftThreadIds: draft ? ["thr_synthetic"] : [] });
    const link = await slot.findByRole("link", { name: /Synthetic chat.*Unread.*Work in progress/ });
    expect(link.querySelector(`[data-thread-status-glyph="${draft ? "working-draft" : "runtime"}"]`)).not.toBeNull();
    const unread = link.querySelector('[data-thread-status-glyph="unread-success"]');
    expect(unread?.parentElement?.classList.contains("flex")).toBe(true);
    expect(link.querySelector(".bb-thread-title")?.parentElement?.contains(unread)).toBe(true);
  });
  it("shows background work without masking an unread error", async () => {
    const row = sidebarThread(); row.indicator = "unread-error"; row.activity.backgroundAgents = 1;
    const { slot } = await page(fixture(), [row]);
    const link = await slot.findByRole("link", { name: /Synthetic chat/ });
    expect(link.querySelector('[data-thread-status-glyph="runtime"]')).not.toBeNull();
    expect(link.querySelector('[data-thread-status-glyph="unread-error"]')).not.toBeNull();
  });
  it("does not claim idle unread chats are working or duplicate an existing work glyph", async () => {
    const idle = await page();
    const idleLink = await idle.slot.findByRole("link", { name: /Synthetic chat/ });
    expect(idleLink.querySelectorAll("[data-thread-status-glyph]")).toHaveLength(1);
    expect(idleLink.getAttribute("aria-label")).not.toContain("Work in progress");
    idle.slot.lifecycle.unmount();
    const active = await page(fixture(), [{ ...sidebarThread(), runtimeStatus: "active", indicator: "runtime", isUnread: false }]);
    const activeLink = await active.slot.findByRole("link", { name: /Synthetic chat/ });
    expect(activeLink.querySelectorAll('[data-thread-status-glyph="runtime"]')).toHaveLength(1);
    expect(activeLink.getAttribute("aria-label")).not.toContain("Unread");
  });
  it("retains normal navigation/mobile onNavigate and native Ctrl/Cmd split", async () => {
    const { slot, onNavigate } = await page(); const link = await slot.findByRole("link", { name: /Synthetic chat/ });
    fireEvent.click(link, { ctrlKey: true }); fireEvent.click(link, { metaKey: true });
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr_synthetic", options: { split: true } },
      { method: "toThread", threadId: "thr_synthetic", options: { split: true } },
    ]);
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.click(link); expect(onNavigate).toHaveBeenCalledOnce();
  });
  it("compact navigation closes the native drawer via the host callback", async () => {
    const { slot, onNavigate } = await page(fixture(), undefined, {}, { isCompactViewport: true });
    fireEvent.click(await slot.findByRole("link", { name: /Synthetic chat/ })); expect(onNavigate).toHaveBeenCalledOnce();
  });
  it("uses host actions and context menus", async () => {
    const run = vi.fn();
    const { slot } = await page(fixture(), undefined, { threadActions: () => [
      { key: "synthetic/action", pluginId: "synthetic", group: "main", action: { label: "Synthetic action", icon: "Clock", run } },
    ] });
    fireEvent.click(await slot.findByRole("button", { name: "Actions: Synthetic chat" }));
    fireEvent.click(await slot.findByRole("menuitem", { name: "Synthetic action" })); expect(run).toHaveBeenCalledOnce();
    fireEvent.contextMenu(slot.getByRole("link", { name: /Synthetic chat/ }));
    expect(await slot.findByRole("menuitem", { name: "Synthetic action" })).toBeTruthy();
  });
  it("distinguishes an empty result from failure and retries explicitly", async () => {
    const empty = await page(fixture([]), []);
    expect(await empty.slot.findByText("No chats with saved messages yet.")).toBeTruthy();
    expect(empty.slot.queryByRole("alert")).toBeNull(); empty.slot.lifecycle.unmount();
    const f = fixture(); f.setFailure(true); const { slot } = await page(f);
    expect(await slot.findByRole("alert")).toBeTruthy(); expect(slot.queryByRole("list")).toBeNull();
    f.setFailure(false); fireEvent.click(slot.getByRole("button", { name: "Retry" }));
    expect(await slot.findByRole("link", { name: /Synthetic chat/ })).toBeTruthy();
  });
  it("recovers the visible error on a new message without requiring manual Retry", async () => {
    const f = fixture(); f.setFailure(true); const { slot } = await page(f);
    expect(await slot.findByRole("alert")).toBeTruthy();
    f.setFailure(false); f.histories.get("thr_synthetic")!.push(assistant(1000));
    f.emit({ id: "thr_synthetic", changes: ["events-appended"], metadata: { eventTypes: ["item/completed"] } });
    expect(await slot.findByRole("link", { name: /Synthetic chat/ }, { timeout: 4000 })).toBeTruthy();
    expect(slot.queryByRole("alert")).toBeNull();
  });
  it("never presents missing host metadata as a complete result", async () => {
    const { slot } = await page(fixture(), []);
    expect(await slot.findByRole("alert")).toBeTruthy(); expect(slot.queryByRole("list")).toBeNull();
  });
  it("shows loading while the RPC is pending", async () => {
    const f = fixture(); let release!: () => void;
    f.setReadHook(() => new Promise<void>(resolve => { release = resolve; }));
    const { slot } = await page(f);
    expect(await slot.findByText("Loading recent chats…")).toBeTruthy();
    await vi.waitFor(() => expect(release).toBeTypeOf("function")); f.setReadHook(); release();
    expect(await slot.findByRole("link", { name: /Synthetic chat/ })).toBeTruthy();
  });
  it("searches loaded chat titles and projects without additional RPCs", async () => {
    const f = fixture([thread("thr_synthetic"), thread("thr_second")]);
    const rows = [sidebarThread(), { ...sidebarThread(), id: "thr_second", displayTitle: "Другой чат", href: "/projects/proj_synthetic/threads/thr_second" }];
    const { slot } = await page(f, rows);
    await slot.findByRole("link", { name: /Другой чат/ });
    const reads = f.calls.length;
    const input = slot.getByRole("searchbox", { name: "Search recent chats" });
    fireEvent.change(input, { target: { value: "  SYNTHETIC CHAT " } });
    expect(slot.getAllByRole("link")).toHaveLength(1);
    expect(slot.getByRole("link", { name: /Synthetic chat/ })).toBeTruthy();
    fireEvent.change(input, { target: { value: "ДРУГОЙ" } });
    expect(slot.getAllByRole("link")).toHaveLength(1);
    expect(slot.getByRole("link", { name: /Другой чат/ })).toBeTruthy();
    fireEvent.change(input, { target: { value: "synthetic PROJECT" } });
    expect(slot.getAllByRole("link")).toHaveLength(2);
    fireEvent.change(input, { target: { value: "not-a-chat" } });
    expect(slot.getByText("No recent chats match your search.")).toBeTruthy();
    expect(slot.queryByRole("link")).toBeNull(); expect(slot.queryByRole("alert")).toBeNull();
    fireEvent.change(input, { target: { value: "" } });
    expect(slot.getAllByRole("link")).toHaveLength(2);
    expect(f.calls).toHaveLength(reads);
    expect(slot.inspection.navigateCalls).toHaveLength(0);
  });
  it("does not hide data failures behind a search no-match state", async () => {
    const f = fixture(); f.setFailure(true); const { slot } = await page(f);
    fireEvent.change(slot.getByRole("searchbox"), { target: { value: "anything" } });
    expect(await slot.findByRole("alert")).toBeTruthy();
    expect(slot.queryByText("No recent chats match your search.")).toBeNull();
  });
  it("keeps row DOM and search through a refresh, without a loading replacement", async () => {
    const f = fixture(); const { slot } = await page(f);
    const link = await slot.findByRole("link", { name: /Synthetic chat/ });
    const input = slot.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "Synthetic" } });
    let release!: () => void;
    f.setReadHook(() => new Promise<void>(resolve => { release = resolve; }));
    fireEvent.click(slot.getByRole("button", { name: "Refresh recent chats" }));
    expect(await slot.findByText("Updating recent chats…")).toBeTruthy();
    expect(slot.getByRole("link", { name: /Synthetic chat/ })).toBe(link);
    expect(slot.queryByText("Loading recent chats…")).toBeNull();
    expect((input as HTMLInputElement).value).toBe("Synthetic");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    f.setReadHook(); release();
    await vi.waitFor(() => expect(slot.queryByText("Updating recent chats…")).toBeNull());
    expect(slot.getByRole("link", { name: /Synthetic chat/ })).toBe(link);
  });
  it("does not change another project's environment when opening a row", async () => {
    const f = fixture([thread("thr_synthetic", { environmentId: "env_synthetic" })]);
    f.histories.set("thr_synthetic", [assistant(500)]);
    const { slot } = await page(f); fireEvent.click(await slot.findByRole("link", { name: /Synthetic chat/ }));
    expect(slot.inspection.sdkCalls.some(call => call.method.includes("update"))).toBe(false);
  });
});
