import {
  experimental_useSidebarThreads,
  useRealtime,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WorkspaceConfig, WorkspaceFolderBrowser } from "./contract.js";
import { rpcContract } from "./contract.js";
import { Button } from "./components/ui/button.js";
import { Checkbox } from "./components/ui/checkbox.js";
import { Icon } from "./components/ui/icon.js";
import { usePluginStylesheet } from "./stylesheet.js";

export const EDIT_WORKSPACE_EVENT = "multi-repo-git:edit-workspace";
const WORKSPACE_RELATIONS_EVENT = "multi-repo-git:workspace-relations";
const REFRESH_WORKSPACES_EVENT = "multi-repo-git:refresh-workspaces";
const WORKSPACE_GROUP_INDENT_PX = 16;
const WORKSPACE_CONTENT_INDENT_PX = 8;
const WORKSPACE_ROOT_CONTENT_INDENT_PX =
  WORKSPACE_GROUP_INDENT_PX + WORKSPACE_CONTENT_INDENT_PX;

function workspaceIndentedWidth(indentPx: number): string {
  return `calc(100% - ${indentPx}px)`;
}

interface WorkspaceLinkView {
  parentProjectId: string;
  childProjectId: string;
  relativePath: string;
  position: number;
}

interface EditWorkspaceDetail {
  projectId: string;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

const modalPanelStyle: React.CSSProperties = {
  position: "fixed",
  left: "50%",
  top: "50%",
  transform: "translate(-50%, -50%)",
  width: "min(520px, calc(100vw - 32px))",
  maxHeight: "min(720px, calc(100vh - 32px))",
  overflowY: "auto",
  zIndex: 10001,
};

function WorkspaceEditor({
  requestedProjectId,
  onClose,
}: {
  requestedProjectId: string;
  onClose: () => void;
}) {
  usePluginStylesheet();
  const rpc = useRpc<typeof rpcContract>();
  const sidebar = experimental_useSidebarThreads();
  const [rootProjectId, setRootProjectId] = useState(requestedProjectId);
  const [config, setConfig] = useState<WorkspaceConfig | null>(null);
  const [browser, setBrowser] = useState<WorkspaceFolderBrowser | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [browserLoading, setBrowserLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const browse = useCallback(
    async (projectId: string, relativePath: string) => {
      setBrowserLoading(true);
      setError(null);
      try {
        setBrowser(
          await rpc.call("workspace_folder_browser", {
            projectId,
            relativePath,
          }),
        );
      } catch (value) {
        setError(errorMessage(value));
      } finally {
        setBrowserLoading(false);
      }
    },
    [rpc],
  );

  const load = useCallback(async () => {
    setError(null);
    setBrowserLoading(true);
    try {
      const relations = await rpc.call("workspace_relations", null);
      const parent = relations.links.find(
        (link) => link.childProjectId === requestedProjectId,
      )?.parentProjectId;
      const resolvedRoot = parent ?? requestedProjectId;
      setRootProjectId(resolvedRoot);
      const [nextConfig, nextBrowser] = await Promise.all([
        rpc.call("workspace_config", { projectId: resolvedRoot }),
        rpc.call("workspace_folder_browser", {
          projectId: resolvedRoot,
          relativePath: ".",
        }),
      ]);
      setConfig(nextConfig);
      setSelectedPaths(
        new Set(nextConfig.children.map((child) => child.relativePath)),
      );
      setBrowser(nextBrowser);
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBrowserLoading(false);
    }
  }, [requestedProjectId, rpc]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const updateWorkspace = async () => {
    const removed =
      config?.children.filter(
        (child) => !selectedPaths.has(child.relativePath),
      ) ?? [];
    if (
      removed.length > 0 &&
      !window.confirm(
        `Remove ${removed.length} folder${removed.length === 1 ? "" : "s"} from this workspace? Their BB projects, chats, environments, worktrees, branches, and files will be kept.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const nextConfig = await rpc.call("workspace_update_folders", {
        parentProjectId: rootProjectId,
        relativePaths: [...selectedPaths],
      });
      setConfig(nextConfig);
      setSelectedPaths(
        new Set(nextConfig.children.map((child) => child.relativePath)),
      );
      window.dispatchEvent(new Event(REFRESH_WORKSPACES_EVENT));
      await browse(rootProjectId, browser?.currentPath ?? ".");
    } catch (value) {
      setError(errorMessage(value));
    } finally {
      setBusy(false);
    }
  };

  const configuredPaths = new Set(
    config?.children.map((child) => child.relativePath) ?? [],
  );
  const hasChanges =
    configuredPaths.size !== selectedPaths.size ||
    [...configuredPaths].some((path) => !selectedPaths.has(path));

  const rootName =
    sidebar.projects.find((project) => project.id === rootProjectId)?.name ??
    "Project";

  return createPortal(
    <div data-bb-plugin="multi-repo-git">
      <button
        type="button"
        aria-label="Close workspace editor"
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 10000,
          border: 0,
          background: "rgb(0 0 0 / 0.4)",
        }}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="multi-repo-workspace-title"
        className="rounded-md border border-border bg-background p-4 shadow-xs"
        style={modalPanelStyle}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 id="multi-repo-workspace-title" className="text-sm font-medium">
              Edit workspace
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Select the folders that should belong to {rootName}, then update
              the workspace.
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
            <Icon name="X" className="size-4" />
          </Button>
        </div>

        <div className="mt-3 space-y-2 rounded-md border border-border p-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <div className="text-xs font-medium">Folders in {rootName}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                Checked folders are the desired workspace. Check or uncheck
                folders, then apply the update. Underlying projects and files
                are never deleted when a folder is unchecked.
              </div>
            </div>
            {browser?.parentPath !== null && browser?.parentPath !== undefined ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || browserLoading}
                onClick={() => void browse(rootProjectId, browser.parentPath!)}
              >
                <Icon name="ChevronLeft" className="size-4" /> Back
              </Button>
            ) : null}
          </div>

          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Icon name="Folder" className="size-3.5" />
            <span className="truncate">
              {browser?.currentPath === "." || browser === null
                ? rootName
                : `${rootName} / ${browser.currentPath}`}
            </span>
          </div>

          <div
            className="space-y-1 overflow-y-auto rounded-md border border-border p-1"
            style={{ maxHeight: 280 }}
          >
            {browserLoading && browser === null ? (
              <div className="p-3 text-center text-xs text-muted-foreground">
                Loading folders…
              </div>
            ) : browser?.folders.length === 0 ? (
              <div className="p-3 text-center text-xs text-muted-foreground">
                No folders here.
              </div>
            ) : (
              browser?.folders.map((folderEntry) => (
                <div
                  key={folderEntry.relativePath}
                  className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-state-hover"
                >
                  <Checkbox
                    aria-label={`Select ${folderEntry.name}`}
                    checked={selectedPaths.has(folderEntry.relativePath)}
                    disabled={busy}
                    onCheckedChange={(checked) => {
                      setSelectedPaths((current) => {
                        const next = new Set(current);
                        if (checked === true) next.add(folderEntry.relativePath);
                        else next.delete(folderEntry.relativePath);
                        return next;
                      });
                    }}
                  />
                  <Icon name="Folder" className="size-4 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{folderEntry.name}</div>
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      {folderEntry.isGitRepository ? (
                        <span className="inline-flex items-center gap-1">
                          <Icon name="GitBranch" className="size-3.5" /> Git repository
                        </span>
                      ) : (
                        <span>Folder</span>
                      )}
                    </div>
                  </div>
                  {folderEntry.hasChildren ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={busy || browserLoading}
                      aria-label={`Open ${folderEntry.name}`}
                      onClick={() =>
                        void browse(rootProjectId, folderEntry.relativePath)
                      }
                    >
                      <Icon name="ChevronRight" className="size-4" />
                    </Button>
                  ) : null}
                </div>
              ))
            )}
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {selectedPaths.size === 0
                ? "No folders selected — the project will remain flat"
                : `${selectedPaths.size} selected`}
            </span>
            <Button
              disabled={busy || config === null || !hasChanges}
              onClick={() => void updateWorkspace()}
            >
              Update workspace
            </Button>
          </div>
        </div>

        {error ? (
          <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-xs text-destructive-foreground">
            {error}
          </div>
        ) : null}

        <div className="mt-3 flex justify-end">
          <Button variant="outline" onClick={onClose}>Done</Button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

export function WorkspaceSidebarController() {
  const rpc = useRpc<typeof rpcContract>();
  const { values } = useSettings();
  const sidebar = experimental_useSidebarThreads();
  const threadParents = useRef<ReadonlyMap<string, string | null>>(new Map());
  threadParents.current = new Map(sidebar.threads.map((thread) => [thread.id, thread.parentThreadId]));
  const configuredPageSize = values?.chatsPerPage;
  const pageSize = typeof configuredPageSize === "number" &&
    Number.isInteger(configuredPageSize) && configuredPageSize >= 1 && configuredPageSize <= 100
    ? configuredPageSize : 5;
  useEffect(() => mountProjectThreadPagination(pageSize, () => threadParents.current), [pageSize]);
  const [requestedProjectId, setRequestedProjectId] = useState<string | null>(
    null,
  );
  const refreshRelations = useCallback(async () => {
    try {
      const result = await rpc.call("workspace_relations", null);
      window.dispatchEvent(
        new CustomEvent<{ links: WorkspaceLinkView[] }>(
          WORKSPACE_RELATIONS_EVENT,
          { detail: result },
        ),
      );
    } catch {
      // The native list remains usable when plugin storage is unavailable.
      window.dispatchEvent(
        new CustomEvent<{ links: WorkspaceLinkView[] }>(
          WORKSPACE_RELATIONS_EVENT,
          { detail: { links: [] } },
        ),
      );
    }
  }, [rpc]);
  useEffect(() => {
    void refreshRelations();
    const listener = () => void refreshRelations();
    window.addEventListener(REFRESH_WORKSPACES_EVENT, listener);
    return () => window.removeEventListener(REFRESH_WORKSPACES_EVENT, listener);
  }, [refreshRelations]);
  useRealtime("workspaces-changed", () => {
    void refreshRelations();
  });
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<EditWorkspaceDetail>).detail;
      if (detail?.projectId) setRequestedProjectId(detail.projectId);
    };
    window.addEventListener(EDIT_WORKSPACE_EVENT, listener);
    return () => window.removeEventListener(EDIT_WORKSPACE_EVENT, listener);
  }, []);

  return (
    <>
      {requestedProjectId ? (
        <WorkspaceEditor
          requestedProjectId={requestedProjectId}
          onClose={() => setRequestedProjectId(null)}
        />
      ) : null}
    </>
  );
}

interface NativeProjectHeadingParts {
  group: HTMLElement;
  heading: HTMLElement;
  title: HTMLElement;
  collapseControl: HTMLButtonElement;
}

interface InlineStyleSnapshot {
  value: string;
  priority: string;
}

function findNativeProjectHeadingParts(
  row: HTMLElement,
): NativeProjectHeadingParts | null {
  const heading = row.querySelector<HTMLElement>(
    ':scope > [data-sidebar-sticky-group] > [data-sidebar="group-label"][data-sidebar-sticky-tier="label"]',
  );
  const group = heading?.parentElement;
  if (
    !heading ||
    !(group instanceof HTMLElement) ||
    !group.matches("[data-sidebar-sticky-group]")
  ) {
    return null;
  }
  const title = heading.querySelector<HTMLElement>("span[title]");
  const collapseControl = Array.from(
    heading.querySelectorAll<HTMLButtonElement>("button[aria-expanded]"),
  ).find((button) => button.querySelector('[data-icon="ChevronRight"]'));
  if (!title || !collapseControl) return null;
  return { group, heading, title, collapseControl };
}

function findNativeProjectContent(
  parts: NativeProjectHeadingParts,
): HTMLElement | null {
  return parts.group.querySelector<HTMLElement>(":scope > .mt-1");
}

function mutationTouches(record: MutationRecord, selector: string): boolean {
  const target = record.target instanceof Element ? record.target : record.target.parentElement;
  if (target?.closest(selector)) return true;
  return record.type === "childList" && [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)]
    .some((node) => node instanceof Element && (node.matches(selector) || node.querySelector(selector) !== null));
}

export function mountProjectThreadPagination(
  pageSize: number,
  getThreadParents: () => ReadonlyMap<string, string | null> = () => new Map(),
): () => void {
  const limits = new Map<string, number>();
  const buttons = new Map<HTMLElement, HTMLButtonElement>();
  const hidden = new Set<HTMLElement>();
  let frame = 0;
  const style = document.createElement("style");
  style.textContent = `
    [data-multi-repo-chat-hidden] { display: none !important; }
    [data-multi-repo-more-chats] {
      display: block; width: 100%; padding: 5px 8px; text-align: left;
      font-size: 12px; border-radius: 6px; color: var(--subtle-foreground);
    }
    [data-multi-repo-more-chats]:hover { background: var(--state-hover); }
    [data-multi-repo-more-chats]:focus-visible { outline: 2px solid var(--foreground); }
  `;
  document.head.append(style);
  const setHidden = (element: HTMLElement, hide: boolean) => {
    if (hide) {
      setAttributeIfChanged(element, "data-multi-repo-chat-hidden", "");
      hidden.add(element);
    } else {
      element.removeAttribute("data-multi-repo-chat-hidden");
      hidden.delete(element);
    }
  };
  const reconcile = () => {
    frame = 0;
    for (const element of hidden) {
      if (!element.isConnected) setHidden(element, false);
    }
    for (const [content, button] of buttons) {
      if (!content.isConnected) {
        button.remove();
        buttons.delete(content);
      }
    }
    for (const row of Array.from(document.querySelectorAll<HTMLElement>("[data-sidebar-project-id]"))) {
      const parts = findNativeProjectHeadingParts(row);
      if (!parts) continue;
      const projectId = row.dataset.sidebarProjectId!;
      const main = row.querySelector("[data-multi-repo-main-label]");
      const collapsed = parts.collapseControl.getAttribute("aria-expanded") === "false" ||
        main?.getAttribute("aria-expanded") === "false" ||
        row.hasAttribute("data-multi-repo-visibility-hidden");
      if (collapsed) limits.delete(projectId);
      const limit = limits.get(projectId) ?? pageSize;
      const content = findNativeProjectContent(parts);
      if (!content) continue;
      let count = 0;
      const parents = getThreadParents();
      // Windowed wrappers remain mounted even when their rows are unloaded.
      // A thread and its entire subtree take one slot; groups do not take slots.
      const visit = (container: HTMLElement) => {
        for (const element of Array.from(container.children)) {
          if (!(element instanceof HTMLElement) || element.hasAttribute("data-multi-repo-more-chats")) continue;
          const before = count;
          const ownThread = element.querySelector<HTMLElement>("[data-sidebar-thread-id]");
          if ((element.hasAttribute("data-sidebar-windowed-item") && ownThread?.closest("[data-sidebar-windowed-item]") === element) ||
            (element.hasAttribute("data-sidebar-sticky-group") &&
              ownThread?.closest('[data-sidebar-sticky-tier="parent"]')?.parentElement === element)) {
            count++;
            for (const descendant of Array.from(element.querySelectorAll<HTMLElement>("[data-multi-repo-chat-hidden]"))) {
              setHidden(descendant, false);
            }
            setHidden(element, before >= limit);
          } else if (element.hasAttribute("data-sidebar-thread-id") ||
            (!element.hasAttribute("data-sidebar-windowed-item") &&
              element.querySelector(":scope > [data-sidebar-thread-id]"))) {
            // Native links are empty overlays; hide their row, not just the link.
            count++;
            setHidden(element, before >= limit);
          } else if (element.hasAttribute("data-sidebar-windowed-nav") && !element.hasChildNodes()) {
            const ids = element.getAttribute("data-sidebar-windowed-nav")!.split(" ")
              .filter(Boolean).map((entry) => entry.slice(0, entry.indexOf(":")));
            const included = new Set(ids);
            count += ids.filter((id) => !included.has(parents.get(id) ?? "")).length;
            setHidden(element, before >= limit);
          } else {
            visit(element);
            // Hide the complete wrapper, including virtual placeholder height.
            if (element.hasAttribute("data-sidebar-windowed-item")) {
              setHidden(element, count > before && before >= limit);
            }
          }
        }
      };
      visit(content);
      let button = buttons.get(content);
      if (count > limit && !collapsed) {
        if (!button) {
          button = document.createElement("button");
          button.type = "button";
          button.dataset.multiRepoMoreChats = "";
          button.textContent = "Show more";
          button.addEventListener("click", (event) => {
            event.stopPropagation();
            limits.set(projectId, (limits.get(projectId) ?? pageSize) + pageSize);
            schedule();
          });
          buttons.set(content, button);
        }
        setAttributeIfChanged(button, "aria-label", `Show ${Math.min(pageSize, count - limit)} more threads in ${parts.title.title}`);
        if (button.parentElement !== content || content.lastElementChild !== button) content.append(button);
      } else if (button) {
        if (document.activeElement === button && !collapsed) {
          const visibleThreads = Array.from(content.querySelectorAll<HTMLElement>("[data-sidebar-thread-id]"))
            .filter((thread) => !thread.closest("[data-multi-repo-chat-hidden]"));
          visibleThreads.at(-1)?.focus({ preventScroll: true });
        }
        button.remove();
        buttons.delete(content);
      }
    }
  };
  function schedule() {
    if (!frame) frame = requestAnimationFrame(reconcile);
  }
  const observer = new MutationObserver((records) => {
    const relevant = records.filter((record) => mutationTouches(record, "[data-sidebar-project-id]"));
    if (relevant.length === 0) return;
    for (const record of relevant) {
      if (record.attributeName !== "aria-expanded" || record.oldValue !== "true") continue;
      const target = record.target;
      if (!(target instanceof HTMLElement)) continue;
      const row = target.closest<HTMLElement>("[data-sidebar-project-id]");
      if (!row || !(target.matches("[data-multi-repo-main-label]") ||
        target === findNativeProjectHeadingParts(row)?.collapseControl)) continue;
      const projectId = row.dataset.sidebarProjectId!;
      limits.delete(projectId);
      if (!target.matches("[data-multi-repo-main-label]")) {
        for (const child of Array.from(document.querySelectorAll<HTMLElement>("[data-multi-repo-workspace-child]"))) {
          if (child.dataset.multiRepoWorkspaceChild === projectId) limits.delete(child.dataset.sidebarProjectId!);
        }
      }
    }
    schedule();
  });
  observer.observe(document.body, {
    childList: true, subtree: true, attributes: true, attributeOldValue: true,
    attributeFilter: ["aria-expanded", "data-multi-repo-visibility-hidden", "data-sidebar-windowed-nav"],
  });
  schedule();
  return () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
    for (const element of hidden) element.removeAttribute("data-multi-repo-chat-hidden");
    for (const button of buttons.values()) button.remove();
    style.remove();
  };
}

function createMainGroupLabel(): HTMLButtonElement {
  const mainLabel = document.createElement("button");
  mainLabel.type = "button";

  const leading = document.createElement("span");
  leading.dataset.multiRepoMainLabelLeading = "";

  const title = document.createElement("span");
  title.dataset.multiRepoMainLabelTitle = "";
  title.textContent = "main";

  const chevronControl = document.createElement("span");
  chevronControl.dataset.multiRepoMainChevronControl = "";

  leading.append(title, chevronControl);
  mainLabel.append(leading);
  return mainLabel;
}

function setAttributeIfChanged(
  element: Element,
  name: string,
  value: string,
): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function setClassNameIfChanged(element: HTMLElement, value: string): void {
  if (element.className !== value) element.className = value;
}

function setInlineStyleIfChanged(
  element: HTMLElement,
  property: string,
  value: string,
): void {
  if (
    element.style.getPropertyValue(property) !== value ||
    element.style.getPropertyPriority(property) !== ""
  ) {
    element.style.setProperty(property, value);
  }
}

const FALLBACK_MAIN_CHEVRON_HTML =
  '<svg aria-hidden="true" data-multi-repo-main-chevron="" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="size-3 transition-transform duration-150"><path d="m9 6 6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function buildMainChevronMarkup(
  reference: NativeProjectHeadingParts,
  collapsed: boolean,
): string {
  const referenceChevron = reference.collapseControl.querySelector<SVGElement>(
    "svg",
  );
  if (!referenceChevron) {
    const holder = document.createElement("span");
    holder.innerHTML = FALLBACK_MAIN_CHEVRON_HTML;
    holder.querySelector("svg")?.classList.toggle("rotate-90", !collapsed);
    return holder.innerHTML;
  }
  const chevron = referenceChevron.cloneNode(true) as SVGElement;
  chevron.removeAttribute("data-icon");
  chevron.removeAttribute("id");
  chevron.classList.remove("rotate-90");
  chevron.setAttribute("data-multi-repo-main-chevron", "");
  chevron.classList.toggle("rotate-90", !collapsed);
  return chevron.outerHTML;
}

function applyMainLabelPresentation(
  mainLabel: HTMLButtonElement,
  reference: NativeProjectHeadingParts,
  collapsed: boolean,
  referenceHeight: number,
): void {
  setClassNameIfChanged(mainLabel, reference.heading.className);
  setInlineStyleIfChanged(
    mainLabel,
    "height",
    referenceHeight > 0 ? `${referenceHeight}px` : "24px",
  );
  setInlineStyleIfChanged(
    mainLabel,
    "width",
    workspaceIndentedWidth(WORKSPACE_GROUP_INDENT_PX),
  );
  setInlineStyleIfChanged(
    mainLabel,
    "margin",
    `2px 0 2px ${WORKSPACE_GROUP_INDENT_PX}px`,
  );
  setInlineStyleIfChanged(mainLabel, "border", "0");
  setInlineStyleIfChanged(mainLabel, "cursor", "pointer");

  const leading = mainLabel.querySelector<HTMLElement>(
    "[data-multi-repo-main-label-leading]",
  );
  const referenceLeading = reference.title.parentElement;
  if (leading) {
    setClassNameIfChanged(
      leading,
      referenceLeading instanceof HTMLElement &&
        reference.heading.contains(referenceLeading)
        ? referenceLeading.className
        : "relative z-10 flex min-w-0 flex-1 items-center gap-1 text-left",
    );
  }

  const title = mainLabel.querySelector<HTMLElement>(
    "[data-multi-repo-main-label-title]",
  );
  if (title) setClassNameIfChanged(title, reference.title.className);

  const chevronControl = mainLabel.querySelector<HTMLElement>(
    "[data-multi-repo-main-chevron-control]",
  );
  if (!chevronControl) return;
  setClassNameIfChanged(chevronControl, reference.collapseControl.className);

  // Recreating the chevron every pass would emit a childList mutation that
  // the plugin's own MutationObserver feeds back into a decoration loop
  // (idle churn). Replace it only when the desired markup actually differs,
  // with the collapse rotation baked in so the desired state is stable.
  const chevronMarkup = buildMainChevronMarkup(reference, collapsed);
  if (chevronControl.innerHTML !== chevronMarkup) {
    chevronControl.innerHTML = chevronMarkup;
  }
}

export function mountWorkspaceProjectMenu(): () => void {
  const injected = new Set<HTMLElement>();
  const menuCleanups: Array<() => void> = [];
  let lastProjectId: string | null = null;
  let workspaceLinks: WorkspaceLinkView[] = [];
  let decorationQueued = false;
  let decorationFrame = 0;
  const menuStyle = document.createElement("style");
  menuStyle.dataset.multiRepoMenuStyle = "";
  menuStyle.textContent = `
    [data-multi-repo-edit-workspace]:hover,
    [data-multi-repo-edit-workspace][data-highlighted] {
      background-color: var(--state-hover);
      color: var(--foreground);
      outline: none;
    }
    /* BB keeps the last native hover independently of Radix focus. While the
       injected item is the last hovered item, suppress that stale background
       without mutating React-owned attributes or destructive text colors. */
    [data-multi-repo-workspace-hover] [data-last-hovered]:not(:focus):not(:hover) {
      background-color: transparent !important;
    }
    [data-multi-repo-edit-workspace] {
      white-space: nowrap;
    }
    [data-multi-repo-edit-workspace] > svg {
      width: 16px;
      height: 16px;
      flex: 0 0 16px;
    }
    [data-multi-repo-project-title-toggle] {
      cursor: pointer;
    }
  `;
  document.head.append(menuStyle);

  const previousDisplay = new Map<HTMLElement, string>();
  const previousStyles = new Map<
    HTMLElement,
    Map<string, InlineStyleSnapshot>
  >();
  const setPluginHidden = (element: HTMLElement, hidden: boolean) => {
    if (hidden) {
      if (!previousDisplay.has(element)) {
        previousDisplay.set(element, element.style.display);
      }
      setAttributeIfChanged(element, "data-multi-repo-visibility-hidden", "");
      setInlineStyleIfChanged(element, "display", "none");
      return;
    }
    const display = previousDisplay.get(element);
    if (display === undefined) return;
    element.style.display = display;
    delete element.dataset.multiRepoVisibilityHidden;
    previousDisplay.delete(element);
  };
  const restorePluginVisibility = (scope?: ParentNode) => {
    for (const [element, display] of [...previousDisplay]) {
      if (scope && !scope.contains(element) && element.isConnected) continue;
      element.style.display = display;
      delete element.dataset.multiRepoVisibilityHidden;
      previousDisplay.delete(element);
    }
  };
  const restoreDetachedPluginVisibility = () => {
    for (const [element, display] of [...previousDisplay]) {
      if (element.isConnected) continue;
      element.style.display = display;
      delete element.dataset.multiRepoVisibilityHidden;
      previousDisplay.delete(element);
    }
  };
  const setPluginStyle = (
    element: HTMLElement,
    property: string,
    value: string,
  ) => {
    if (
      element.style.getPropertyValue(property) === value &&
      element.style.getPropertyPriority(property) === ""
    ) {
      return;
    }
    let previous = previousStyles.get(element);
    if (!previous) {
      previous = new Map();
      previousStyles.set(element, previous);
    }
    if (!previous.has(property)) {
      previous.set(property, {
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
      });
    }
    element.style.setProperty(property, value);
  };
  const restorePluginStylesForElement = (element: HTMLElement) => {
    const previous = previousStyles.get(element);
    if (!previous) return;
    for (const [property, snapshot] of previous) {
      if (snapshot.value === "") {
        element.style.removeProperty(property);
      } else {
        element.style.setProperty(property, snapshot.value, snapshot.priority);
      }
    }
    previousStyles.delete(element);
  };
  const restorePluginStyles = (scope?: ParentNode) => {
    for (const element of [...previousStyles.keys()]) {
      if (scope && !scope.contains(element) && element.isConnected) continue;
      restorePluginStylesForElement(element);
    }
  };
  const restoreDetachedPluginStyles = () => {
    for (const element of [...previousStyles.keys()]) {
      if (!element.isConnected) restorePluginStylesForElement(element);
    }
  };
  const clearChildContentDecoration = (scope: ParentNode) => {
    for (const content of Array.from(
      scope.querySelectorAll<HTMLElement>(
        "[data-multi-repo-workspace-child-content]",
      ),
    )) {
      delete content.dataset.multiRepoWorkspaceChildContent;
      restorePluginStylesForElement(content);
    }
  };
  const restoreWorkspaceContent = (scope: ParentNode = document) => {
    for (const content of Array.from(
      scope.querySelectorAll<HTMLElement>("[data-multi-repo-main-content]"),
    )) {
      setPluginHidden(content, false);
      delete content.dataset.multiRepoMainContent;
    }
    clearChildContentDecoration(scope);
    restorePluginStyles(scope);
  };
  const clearWorkspaceRowDecoration = (row: HTMLElement) => {
    setPluginHidden(row, false);
    delete row.dataset.multiRepoWorkspaceRoot;
    delete row.dataset.multiRepoWorkspaceChild;
    restoreWorkspaceContent(row);
    const mainLabel = row.querySelector<HTMLElement>(
      "[data-multi-repo-main-label]",
    );
    if (mainLabel) {
      setPluginHidden(mainLabel, false);
      mainLabel.remove();
    }
  };

  const clearDecorations = () => {
    restorePluginVisibility();
    restoreWorkspaceContent();
    for (const title of Array.from(
      document.querySelectorAll<HTMLElement>(
        "[data-multi-repo-project-title-toggle]",
      ),
    )) {
      delete title.dataset.multiRepoProjectTitleToggle;
    }
    for (const row of Array.from(
      document.querySelectorAll<HTMLElement>(
        "[data-multi-repo-workspace-root], [data-multi-repo-workspace-child]",
      ),
    )) {
      delete row.dataset.multiRepoWorkspaceRoot;
      delete row.dataset.multiRepoWorkspaceChild;
    }
    for (const label of Array.from(
      document.querySelectorAll<HTMLElement>("[data-multi-repo-main-label]"),
    )) {
      label.remove();
    }
  };

  const decorateWorkspaces = () => {
    decorationQueued = false;
    decorationFrame = 0;
    // Read geometry in one batch before changing styles, not once per workspace
    // after the previous workspace's writes (forced layout on every iteration).
    const referenceHeights = new Map(Array.from(document.querySelectorAll<HTMLElement>(
      '[data-sidebar-project-id] [data-sidebar="group-label"][data-sidebar-sticky-tier="label"]',
    )).map((heading) => [heading, heading.getBoundingClientRect().height]));
    restoreDetachedPluginVisibility();
    restoreDetachedPluginStyles();
    for (const row of Array.from(
      document.querySelectorAll<HTMLElement>("[data-sidebar-project-id]"),
    )) {
      const parts = findNativeProjectHeadingParts(row);
      const previousTitles = Array.from(
        row.querySelectorAll<HTMLElement>(
          "[data-multi-repo-project-title-toggle]",
        ),
      );
      for (const title of previousTitles) {
        if (title !== parts?.title) delete title.dataset.multiRepoProjectTitleToggle;
      }
      if (parts) {
        setAttributeIfChanged(
          parts.title,
          "data-multi-repo-project-title-toggle",
          "",
        );
      }
    }
    const linksByParent = new Map<string, WorkspaceLinkView[]>();
    const childIds = new Set<string>();
    for (const link of workspaceLinks) {
      const links = linksByParent.get(link.parentProjectId) ?? [];
      links.push(link);
      linksByParent.set(link.parentProjectId, links);
      childIds.add(link.childProjectId);
    }
    for (const row of Array.from(
      document.querySelectorAll<HTMLElement>(
        "[data-multi-repo-workspace-root], [data-multi-repo-workspace-child]",
      ),
    )) {
      const projectId = row.dataset.sidebarProjectId ?? "";
      if (
        linksByParent.has(projectId) ||
        (childIds.has(projectId) && row.dataset.multiRepoWorkspaceChild)
      ) {
        continue;
      }
      clearWorkspaceRowDecoration(row);
    }
    for (const [parentProjectId, links] of linksByParent) {
      links.sort((left, right) => left.position - right.position);
      const root = document.querySelector<HTMLElement>(
        `[data-sidebar-project-id="${CSS.escape(parentProjectId)}"]`,
      );
      if (!root) {
        for (const link of links) {
          const child = document.querySelector<HTMLElement>(
            `[data-sidebar-project-id="${CSS.escape(link.childProjectId)}"]`,
          );
          if (child) clearWorkspaceRowDecoration(child);
        }
        continue;
      }

      const rootParts = findNativeProjectHeadingParts(root);
      if (!rootParts) {
        clearWorkspaceRowDecoration(root);
        for (const link of links) {
          const child = document.querySelector<HTMLElement>(
            `[data-sidebar-project-id="${CSS.escape(link.childProjectId)}"]`,
          );
          if (child) clearWorkspaceRowDecoration(child);
        }
        continue;
      }

      const rootExpanded =
        rootParts.collapseControl.getAttribute("aria-expanded") !== "false";
      const rootContent = findNativeProjectContent(rootParts);
      if (rootExpanded && !rootContent) {
        clearWorkspaceRowDecoration(root);
        for (const link of links) {
          const child = document.querySelector<HTMLElement>(
            `[data-sidebar-project-id="${CSS.escape(link.childProjectId)}"]`,
          );
          if (child) clearWorkspaceRowDecoration(child);
        }
        continue;
      }

      setAttributeIfChanged(root, "data-multi-repo-workspace-root", "");
      let visualReference = rootParts;
      for (const link of links) {
        const candidate = document.querySelector<HTMLElement>(
          `[data-sidebar-project-id="${CSS.escape(link.childProjectId)}"]`,
        );
        const candidateParts = candidate
          ? findNativeProjectHeadingParts(candidate)
          : null;
        if (candidateParts) {
          visualReference = candidateParts;
          break;
        }
      }

      if (rootContent) {
        setAttributeIfChanged(
          rootContent,
          "data-multi-repo-main-content",
          parentProjectId,
        );
        setPluginStyle(
          rootContent,
          "margin-left",
          `${WORKSPACE_ROOT_CONTENT_INDENT_PX}px`,
        );
        setPluginStyle(
          rootContent,
          "width",
          workspaceIndentedWidth(WORKSPACE_ROOT_CONTENT_INDENT_PX),
        );

        let mainLabel = rootParts.group.querySelector<HTMLButtonElement>(
          "[data-multi-repo-main-label]",
        );
        if (
          mainLabel &&
          mainLabel.dataset.multiRepoMainLabel !== parentProjectId
        ) {
          setPluginHidden(mainLabel, false);
          mainLabel.remove();
          mainLabel = null;
        }
        if (!mainLabel) {
          const label = createMainGroupLabel();
          label.dataset.multiRepoMainLabel = parentProjectId;
          label.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            const nextCollapsed = label.getAttribute("aria-expanded") === "true";
            try {
              localStorage.setItem(
                `multi-repo-git:main-collapsed:${parentProjectId}`,
                String(nextCollapsed),
              );
            } catch {
              // Collapse still works for this session when storage is blocked.
            }
            label.setAttribute("aria-expanded", String(!nextCollapsed));
            queueDecorations();
          });
          rootParts.group.insertBefore(label, rootContent);
          mainLabel = label;
        }

        let collapsed = false;
        try {
          collapsed =
            localStorage.getItem(
              `multi-repo-git:main-collapsed:${parentProjectId}`,
            ) === "true";
        } catch {
          // Default to expanded when storage is blocked.
        }
        applyMainLabelPresentation(mainLabel, visualReference, collapsed, referenceHeights.get(visualReference.heading) ?? 0);
        setAttributeIfChanged(
          mainLabel,
          "aria-expanded",
          String(!collapsed),
        );
        setAttributeIfChanged(
          mainLabel,
          "aria-label",
          collapsed ? "Expand main group" : "Collapse main group",
        );
        // BB owns root-project content visibility through the native collapse.
        // The plugin only layers the independent `main` state on that content.
        setPluginHidden(rootContent, collapsed);
      }

      const mainLabel = rootParts.group.querySelector<HTMLElement>(
        "[data-multi-repo-main-label]",
      );
      if (mainLabel) setPluginHidden(mainLabel, !rootExpanded);

      let cursor: Element = root;
      for (const link of links) {
        const child = document.querySelector<HTMLElement>(
          `[data-sidebar-project-id="${CSS.escape(link.childProjectId)}"]`,
        );
        if (!child) continue;
        const childParts = findNativeProjectHeadingParts(child);
        if (!childParts) {
          clearWorkspaceRowDecoration(child);
          continue;
        }

        setAttributeIfChanged(
          child,
          "data-multi-repo-workspace-child",
          parentProjectId,
        );
        setPluginStyle(
          child,
          "margin-left",
          `${WORKSPACE_GROUP_INDENT_PX}px`,
        );
        setPluginStyle(
          child,
          "width",
          workspaceIndentedWidth(WORKSPACE_GROUP_INDENT_PX),
        );
        setPluginStyle(child, "margin-block-start", "4px");

        const childContent = findNativeProjectContent(childParts);
        if (childContent) {
          setAttributeIfChanged(
            childContent,
            "data-multi-repo-workspace-child-content",
            parentProjectId,
          );
          setPluginStyle(
            childContent,
            "margin-left",
            `${WORKSPACE_CONTENT_INDENT_PX}px`,
          );
          setPluginStyle(
            childContent,
            "width",
            workspaceIndentedWidth(WORKSPACE_CONTENT_INDENT_PX),
          );
        } else {
          clearChildContentDecoration(child);
        }

        setPluginHidden(child, !rootExpanded);
        // Newer BB wraps projects in independent visibility groups. Decorate
        // their native rows in place; sectionOrder already groups those wrappers.
        if (cursor.parentElement === child.parentElement && cursor.nextElementSibling !== child) {
          cursor.insertAdjacentElement("afterend", child);
        }
        cursor = child;
      }
    }
  };

  function queueDecorations() {
    if (decorationQueued) return;
    decorationQueued = true;
    decorationFrame = requestAnimationFrame(decorateWorkspaces);
  }

  const receiveRelations = (event: Event) => {
    const detail = (event as CustomEvent<{ links: WorkspaceLinkView[] }>).detail;
    workspaceLinks = Array.isArray(detail?.links) ? detail.links : [];
    queueDecorations();
  };

  const rememberTrigger = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const trigger = target.closest<HTMLButtonElement>(
      "[data-sidebar-project-id] button[aria-haspopup='menu']",
    );
    const row = trigger?.closest<HTMLElement>("[data-sidebar-project-id]");
    if (row?.dataset.sidebarProjectId) {
      lastProjectId = row.dataset.sidebarProjectId;
      queueMicrotask(inject);
    }
  };

  const inject = () => {
    if (!lastProjectId) return;
    for (const menu of Array.from(
      document.querySelectorAll<HTMLElement>("[role='menu']"),
    )) {
      if (menu.querySelector("[data-multi-repo-edit-workspace]")) continue;
      const items = Array.from(
        menu.querySelectorAll<HTMLElement>("[role='menuitem']"),
      );
      const settingsItem = items.find((item) =>
        item.textContent?.trim().startsWith("Project settings"),
      );
      const hasProjectActions = items.some((item) =>
        item.textContent?.trim().startsWith("Rename"),
      );
      if (!settingsItem || !hasProjectActions) continue;

      const item = document.createElement("div");
      item.dataset.multiRepoEditWorkspace = "";
      item.setAttribute("role", "menuitem");
      item.setAttribute("tabindex", "-1");
      item.className = settingsItem.className;
      item.innerHTML =
        '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 6h7l2 2h9v10H3z"/><path d="M8 12h8M12 12v4"/></svg><span>Edit workspace</span>';
      const projectId = lastProjectId;
      const highlight = () => {
        menu.dataset.multiRepoWorkspaceHover = "";
        item.dataset.highlighted = "";
      };
      const receiveNativeHover = (event: Event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const nativeItem = target.closest("[role='menuitem']");
        if (nativeItem && nativeItem !== item && menu.contains(nativeItem)) {
          delete menu.dataset.multiRepoWorkspaceHover;
        }
      };
      const receiveWorkspaceKeys = (event: KeyboardEvent) => {
        const active = document.activeElement;
        const direction = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
        const enabled = Array.from(menu.querySelectorAll<HTMLElement>(
          '[role="menuitem"]:not([data-disabled]):not([aria-disabled="true"])',
        ));
        const index = enabled.indexOf(active as HTMLElement);
        if (active !== item && (!direction || enabled[index + direction] !== item)) return;
        if (!direction && event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        if (direction) enabled[index + direction]?.focus({ preventScroll: true });
        else item.click();
      };
      menu.addEventListener("pointerover", receiveNativeHover);
      menu.addEventListener("focusin", receiveNativeHover);
      menu.addEventListener("keydown", receiveWorkspaceKeys, true);
      menuCleanups.push(() => {
        menu.removeEventListener("pointerover", receiveNativeHover);
        menu.removeEventListener("focusin", receiveNativeHover);
        menu.removeEventListener("keydown", receiveWorkspaceKeys, true);
        delete menu.dataset.multiRepoWorkspaceHover;
      });
      const highlightFromPointer = (event: Event) => {
        if ((event as PointerEvent).pointerType === "touch") return;
        // Radix derives native item highlighting from focus. Move focus too,
        // rather than leaving the last native item highlighted alongside ours.
        item.focus({ preventScroll: true });
      };
      const clearHighlight = () => {
        delete item.dataset.highlighted;
      };
      const leaveFromPointer = () => {
        // Match Radix's onItemLeave: return focus to the menu background.
        if (document.activeElement === item) menu.focus({ preventScroll: true });
        clearHighlight();
      };
      item.addEventListener("pointerover", highlightFromPointer);
      item.addEventListener("pointermove", highlightFromPointer);
      item.addEventListener("mousemove", highlightFromPointer);
      item.addEventListener("pointerenter", highlightFromPointer);
      item.addEventListener("pointerleave", leaveFromPointer);
      item.addEventListener("focus", highlight);
      item.addEventListener("blur", clearHighlight);
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        window.dispatchEvent(
          new CustomEvent<EditWorkspaceDetail>(EDIT_WORKSPACE_EVENT, {
            detail: { projectId },
          }),
        );
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      });
      settingsItem.insertAdjacentElement("afterend", item);
      injected.add(item);
    }
  };

  let delegatingTitleClick = false;
  const toggleProjectFromTitle = (event: MouseEvent) => {
    if (delegatingTitleClick || event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const title = target.closest<HTMLElement>(
      "[data-multi-repo-project-title-toggle]",
    );
    if (!title) return;
    const row = title.closest<HTMLElement>("[data-sidebar-project-id]");
    if (!row) return;
    const parts = findNativeProjectHeadingParts(row);
    if (!parts || parts.title !== title || !parts.heading.contains(title)) return;
    if (
      target.closest(
        "button, a, input, select, textarea, [contenteditable='true'], [draggable='true']",
      )
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    delegatingTitleClick = true;
    try {
      parts.collapseControl.click();
    } finally {
      delegatingTitleClick = false;
    }
    queueDecorations();
  };

  document.addEventListener("pointerdown", rememberTrigger, true);
  document.addEventListener("click", rememberTrigger, true);
  document.addEventListener("click", toggleProjectFromTitle, true);
  const observer = new MutationObserver((records) => {
    if (records.some((record) => record.type === "childList" && mutationTouches(record, "[role='menu']"))) inject();
    if (records.some((record) => mutationTouches(record, "[data-sidebar-project-id]"))) queueDecorations();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-expanded"],
  });
  window.addEventListener(WORKSPACE_RELATIONS_EVENT, receiveRelations);

  return () => {
    document.removeEventListener("pointerdown", rememberTrigger, true);
    document.removeEventListener("click", rememberTrigger, true);
    document.removeEventListener("click", toggleProjectFromTitle, true);
    window.removeEventListener(WORKSPACE_RELATIONS_EVENT, receiveRelations);
    observer.disconnect();
    cancelAnimationFrame(decorationFrame);
    clearDecorations();
    menuStyle.remove();
    for (const cleanup of menuCleanups) cleanup();
    for (const item of injected) item.remove();
  };
}
