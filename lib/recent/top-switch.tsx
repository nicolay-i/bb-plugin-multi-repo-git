import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSdk } from "@get-bb/plugin-sdk/app";

export const RECENT_PROVIDER = "multi-repo-git/recent";
export const WORKSPACES_PROVIDER = "thread-list/thread-list";
const KEY = "sidebar.threadListProvider";
const ANCHOR = '[data-testid="app-sidebar-body"] > [data-sidebar="content"]';

// BB has no additive header slot. Decorate only the shell, never clone its tree.
export function mountModeTargets(changed: (targets: HTMLElement[]) => void): () => void {
  const targets = new Map<Element, HTMLElement>();
  function sync() {
    let modified = false;
    for (const [content, target] of targets) {
      if (!content.isConnected || !target.isConnected) {
        target.remove(); targets.delete(content); modified = true;
      }
    }
    for (const content of Array.from(document.querySelectorAll(ANCHOR))) {
      if (targets.has(content)) continue;
      const target = document.createElement("div");
      target.dataset.atriumModeSwitch = "";
      target.style.cssText = "flex-shrink:0;min-width:0;padding:4px 8px";
      targets.set(content, target);
      content.before(target); modified = true;
    }
    if (modified) changed([...targets.values()]);
  }
  const observer = new MutationObserver(records => {
    // Ignore streaming chat content and ordinary list-row updates.
    if (records.some(record => record.target instanceof Element &&
        record.target.matches('[data-testid="app-sidebar-body"]') ||
        [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some(node => node instanceof Element &&
          (node.matches('[data-testid="app-sidebar-body"], [data-sidebar="content"]') || node.querySelector(ANCHOR))))) sync();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  sync();
  return () => { observer.disconnect(); for (const target of targets.values()) target.remove(); targets.clear(); };
}

export function SidebarModeControls() {
  const sdk = useSdk();
  const [targets, setTargets] = useState<HTMLElement[]>([]);
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previous, setPrevious] = useState<string | null>(null);
  const mounted = useRef(false);
  const switching = useRef(false);
  const readVersion = useRef(0);
  useEffect(() => mountModeTargets(setTargets), []);
  useEffect(() => {
    mounted.current = true;
    const read = async () => {
      const version = ++readVersion.current;
      try {
        const result = await sdk.system.uiPreferences.list();
        if (mounted.current && version === readVersion.current) {
          setValue(result.preferences[KEY].value); setError(null);
        }
      } catch {
        if (mounted.current && version === readVersion.current) {
          setValue(null); setError("Could not read the sidebar view preference.");
        }
      }
    };
    void read();
    const off = sdk.subscribe({ event: "system:changed", callback: event => {
      if (event.changes.includes("ui-preferences-changed")) void read();
    } });
    return () => { mounted.current = false; ++readVersion.current; off(); };
  }, [sdk]);

  async function choose(next: string) {
    if (switching.current) return;
    switching.current = true; setBusy(true); setError(null);
    try {
      const { preferences } = await sdk.system.uiPreferences.list();
      if (!mounted.current) return;
      const current = preferences[KEY];
      if (current.value !== next) {
        const result = await sdk.system.uiPreferences.set({ key: KEY, value: next, expectedRevision: current.revision });
        if (mounted.current) {
          if (current.value !== WORKSPACES_PROVIDER && current.value !== RECENT_PROVIDER) setPrevious(current.value);
          ++readVersion.current; setValue(result.value);
        }
      } else setValue(current.value);
    } catch {
      if (mounted.current) setError("Could not switch sidebar views. Another client may have changed the preference. Choose again to retry.");
    } finally {
      switching.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return targets.map(target => createPortal(<>
    <style>{`
      [data-atrium-mode-switch] button:not(:disabled):hover { --atrium-mode-hover: var(--sidebar-accent); box-shadow: inset 0 0 0 1px var(--sidebar-border); }
      [data-atrium-mode-switch] button:focus-visible { outline: 2px solid var(--ring); outline-offset: 1px; }
    `}</style>
    <div role="group" aria-label="Chat list view" style={{ display: "flex", gap: 3, minWidth: 0, padding: 3, border: "1px solid var(--sidebar-border)", borderRadius: 8, background: "var(--sidebar)", color: "var(--sidebar-foreground)" }} className="flex min-w-0 gap-1 rounded-lg border border-sidebar-border bg-sidebar p-1 text-sidebar-foreground">
      {[[WORKSPACES_PROVIDER, "Workspaces"], [RECENT_PROVIDER, "Recent"]].map(([provider, label]) =>
        <button key={provider} type="button" aria-pressed={value === provider} disabled={busy}
          onClick={() => void choose(provider)}
          style={{ flex: 1, minWidth: 0, minHeight: 30, padding: "4px 8px", borderRadius: 5, font: "inherit", fontSize: 12, cursor: busy ? "wait" : "pointer", background: value === provider ? "var(--sidebar-accent)" : "var(--atrium-mode-hover, transparent)" }}
          className={`min-h-7 min-w-0 flex-1 rounded-md px-2 py-1 text-xs focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 ${value === provider ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/60"}`}>{label}</button>)}
    </div>
    {previous && value !== previous ? <button type="button" disabled={busy} onClick={() => void choose(previous)}
      style={{ marginTop: 4, fontSize: 12, textDecoration: "underline" }} className="mt-1 text-xs text-muted-foreground underline">Restore previous view</button> : null}
    {error ? <p role="alert" style={{ marginTop: 4, fontSize: 12, color: "var(--destructive)" }} className="mt-1 text-xs text-destructive">{error}</p> : null}
  </>, target));
}
