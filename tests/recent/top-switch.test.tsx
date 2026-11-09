// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import { mountModeTargets, RECENT_PROVIDER, WORKSPACES_PROVIDER } from "../../lib/recent/top-switch.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const off of cleanups.splice(0).reverse()) off(); document.body.replaceChildren(); });
function shell() {
  const body = document.createElement("aside"); body.dataset.testid = "app-sidebar-body";
  const list = document.createElement("div"); list.dataset.sidebar = "content"; list.textContent = "Native tree";
  body.append(list); document.body.append(body);
  const draft = document.createElement("textarea"); draft.value = "Unsubmitted draft"; document.body.append(draft);
  return { body, list, draft };
}
async function controls(initial = WORKSPACES_PROVIDER) {
  const nodes = shell(); let value = initial, revision = 5;
  const listeners = new Set<(event: any) => void>();
  const list = vi.fn(async () => ({ preferences: { "sidebar.threadListProvider": { value, revision } } } as any));
  const set = vi.fn(async (input: any) => {
    if (input.expectedRevision !== revision) throw new Error("Synthetic CAS conflict");
    value = input.value; revision++;
    return { key: "sidebar.threadListProvider" as const, value, revision };
  });
  const app = await loadPluginApp(() => import("../../app.js"));
  const slot = renderSlot(app.appOverlays.find(item => item.id === "sidebar-view-switch")!, {}, {
    sdk: { system: { uiPreferences: { list, set: set as PluginBrowserBbSdk["system"]["uiPreferences"]["set"] } }, subscribe: ((args: any) => {
      listeners.add(args.callback); return () => { listeners.delete(args.callback); };
    }) as any },
  });
  cleanups.push(() => slot.lifecycle.unmount());
  await waitFor(() => expect(slot.getByRole("button", { name: initial === WORKSPACES_PROVIDER ? "Workspaces" : "Recent" }).getAttribute("aria-pressed")).toBe(initial === RECENT_PROVIDER || initial === WORKSPACES_PROVIDER ? "true" : "false"));
  return { ...nodes, slot, readPreference: list, set, value: () => value, listeners,
    external(next: string) { value = next; revision++; for (const fn of listeners) fn({ changes: ["ui-preferences-changed"] }); },
  };
}

describe("Top sidebar view switch", () => {
  it("decorates above the native scroll area without taking over any native node", async () => {
    const h = await controls();
    const group = h.slot.getByRole("group", { name: "Chat list view" });
    expect(group.parentElement?.nextElementSibling).toBe(h.list);
    expect(h.body.lastChild).toBe(h.list); expect(h.draft.value).toBe("Unsubmitted draft");
    expect(h.set).not.toHaveBeenCalled();
    fireEvent.click(h.slot.getByRole("button", { name: "Recent" }));
    await waitFor(() => expect(h.value()).toBe(RECENT_PROVIDER));
    expect(h.set).toHaveBeenCalledWith({ key: "sidebar.threadListProvider", value: RECENT_PROVIDER, expectedRevision: 5 });
    fireEvent.click(h.slot.getByRole("button", { name: "Workspaces" }));
    await waitFor(() => expect(h.value()).toBe(WORKSPACES_PROVIDER));
    expect(h.set).toHaveBeenLastCalledWith({ key: "sidebar.threadListProvider", value: WORKSPACES_PROVIDER, expectedRevision: 6 });
    expect(h.draft.isConnected).toBe(true); expect(h.slot.inspection.navigateCalls).toHaveLength(0);
  });
  it("reflects another client's preference without overwriting it", async () => {
    const h = await controls(); h.external(RECENT_PROVIDER);
    await waitFor(() => expect(h.slot.getByRole("button", { name: "Recent" }).getAttribute("aria-pressed")).toBe("true"));
    expect(h.set).not.toHaveBeenCalled();
  });
  it("reports CAS failure without resetting or silently retrying", async () => {
    const h = await controls(); h.set.mockRejectedValueOnce(new Error("Conflict"));
    fireEvent.click(h.slot.getByRole("button", { name: "Recent" }));
    expect(await h.slot.findByRole("alert")).toBeTruthy();
    expect(h.value()).toBe(WORKSPACES_PROVIDER); expect(h.set).toHaveBeenCalledOnce();
    expect(h.slot.inspection.navigateCalls).toHaveLength(0);
  });
  it("preserves a previous third-party provider for an explicit return", async () => {
    const h = await controls("other/list");
    fireEvent.click(h.slot.getByRole("button", { name: "Recent" }));
    const restore = await h.slot.findByRole("button", { name: "Restore previous view" });
    fireEvent.click(restore); await waitFor(() => expect(h.value()).toBe("other/list"));
  });
  it("survives native remounts, ignores row/stream changes, and cleans up", async () => {
    const nodes = shell(), changed = vi.fn(); const off = mountModeTargets(changed); cleanups.push(off);
    const first = nodes.body.firstElementChild;
    nodes.list.replaceChildren(document.createElement("ul"));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(changed).toHaveBeenCalledOnce();
    nodes.body.innerHTML = '<div data-sidebar="content"></div>';
    await waitFor(() => expect(document.querySelectorAll("[data-atrium-mode-switch]")).toHaveLength(1));
    expect(first?.isConnected).toBe(false);
    off(); expect(document.querySelector("[data-atrium-mode-switch]")).toBeNull();
    nodes.body.innerHTML = '<div data-sidebar="content"></div>';
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.querySelector("[data-atrium-mode-switch]")).toBeNull();
  });
  it("unmount removes portals/observers/subscriptions and never changes preferences", async () => {
    const h = await controls(); h.slot.lifecycle.unmount();
    expect(document.querySelector("[data-atrium-mode-switch]")).toBeNull();
    expect(h.listeners.size).toBe(0); expect(h.set).not.toHaveBeenCalled();
  });
});
