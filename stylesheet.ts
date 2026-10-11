import { useInsertionEffect } from "react";

const STYLESHEET_SELECTOR =
  'link[data-bb-plugin-css="multi-repo-git"]';
const DISABLED_MEDIA = "not all";

let consumerCount = 0;
let observer: MutationObserver | null = null;
const originalMedia = new Map<HTMLLinkElement, string>();

function stylesheetLinks(): HTMLLinkElement[] {
  return Array.from(document.querySelectorAll<HTMLLinkElement>(STYLESHEET_SELECTOR));
}

function syncStylesheets(): void {
  for (const link of stylesheetLinks()) {
    if (!originalMedia.has(link)) originalMedia.set(link, link.media);
    link.media = consumerCount > 0 ? (originalMedia.get(link) ?? "") : DISABLED_MEDIA;
  }
}

export function mountLazyPluginStylesheet(): () => void {
  syncStylesheets();
  observer = new MutationObserver(syncStylesheets);
  observer.observe(document.head, { childList: true });
  return () => {
    observer?.disconnect();
    observer = null;
    consumerCount = 0;
    for (const [link, media] of originalMedia) {
      if (link.isConnected) link.media = media;
    }
    originalMedia.clear();
  };
}

export function retainPluginStylesheet(): () => void {
  consumerCount += 1;
  syncStylesheets();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    consumerCount = Math.max(0, consumerCount - 1);
    syncStylesheets();
  };
}

export function usePluginStylesheet(): void {
  useInsertionEffect(() => retainPluginStylesheet(), []);
}
