// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  loadPluginApp,
  mountPluginContentScripts,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  document.head
    .querySelectorAll('link[data-bb-plugin-css="multi-repo-git"]')
    .forEach((element) => element.remove());
  localStorage.clear();
});

function availableRepository(relativePath = ".") {
  return {
    projectId: "project-root",
    relativePath,
    name: relativePath === "." ? "umbrella" : "child",
    available: true,
    unavailableReason: null,
    error: null,
    branch: "task/native",
    detached: false,
    head: "abc1234",
    upstream: "origin/task/native",
    ahead: 0,
    behind: 0,
    files: [],
  };
}

interface NativeProjectRowFixture {
  row: HTMLDivElement;
  heading: HTMLDivElement;
  title: HTMLSpanElement;
  collapseControl: HTMLButtonElement;
  actionControl: HTMLButtonElement;
  content: HTMLDivElement;
  threadRow: HTMLDivElement | null;
  emptyState: HTMLDivElement | null;
}

function ensureCssEscape() {
  if (typeof CSS === "undefined") {
    Object.defineProperty(globalThis, "CSS", {
      configurable: true,
      value: { escape: (value: string) => value },
    });
    return;
  }
  if (typeof CSS.escape !== "function") {
    Object.defineProperty(CSS, "escape", {
      configurable: true,
      value: (value: string) => value,
    });
  }
}

function createNativeProjectRow({
  projectId,
  name,
  threadTitle,
}: {
  projectId: string;
  name: string;
  threadTitle?: string;
}): NativeProjectRowFixture {
  const row = document.createElement("div");
  row.dataset.sidebarProjectId = projectId;

  const group = document.createElement("div");
  group.dataset.sidebarStickyGroup = "";
  group.className = "native-sticky-group";

  const heading = document.createElement("div");
  heading.dataset.sidebar = "group-label";
  heading.dataset.sidebarStickyTier = "label";
  heading.className =
    "native-heading bb-sidebar-hover-actions-row text-xs font-normal leading-5 text-subtle-foreground/75 pl-2 rounded-md pr-0 transition-colors";

  const leading = document.createElement("span");
  leading.className =
    "native-leading relative z-10 flex min-w-0 flex-1 items-center gap-1 text-left";

  const title = document.createElement("span");
  title.title = name;
  title.className = "native-title min-w-0 truncate";
  title.textContent = name;

  const collapseControl = document.createElement("button");
  collapseControl.type = "button";
  collapseControl.setAttribute("aria-expanded", "true");
  collapseControl.className =
    "native-collapse bb-sidebar-hover-actions relative z-20 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-subtle-foreground";
  const chevron = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "svg",
  );
  chevron.setAttribute("data-icon", "ChevronRight");
  chevron.setAttribute("class", "native-chevron size-3 transition-transform duration-150 rotate-90");
  chevron.setAttribute("viewBox", "0 0 24 24");
  chevron.innerHTML =
    '<path d="m9 6 6 6-6 6" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/>';
  collapseControl.append(chevron);
  collapseControl.addEventListener("click", () => {
    collapseControl.setAttribute(
      "aria-expanded",
      String(collapseControl.getAttribute("aria-expanded") === "false"),
    );
  });

  leading.append(title, collapseControl);

  const actionControl = document.createElement("button");
  actionControl.type = "button";
  actionControl.setAttribute("aria-haspopup", "menu");
  actionControl.textContent = "Actions";
  heading.append(leading, actionControl);

  const content = document.createElement("div");
  content.className = "mt-1 native-content";

  let threadRow: HTMLDivElement | null = null;
  let emptyState: HTMLDivElement | null = null;
  if (threadTitle) {
    threadRow = document.createElement("div");
    threadRow.dataset.sidebarThreadId = `${projectId}-thread`;
    threadRow.className = "native-thread-row";
    threadRow.style.fontSize = "13px";
    const threadName = document.createElement("span");
    threadName.className = "bb-sidebar-thread-title";
    threadName.textContent = threadTitle;
    threadRow.append(threadName);
    content.append(threadRow);
  } else {
    emptyState = document.createElement("div");
    emptyState.dataset.nativeEmptyState = "";
    emptyState.className = "native-empty-state";
    emptyState.textContent = "No threads";
    content.append(emptyState);
  }

  group.append(heading, content);
  row.append(group);
  return {
    row,
    heading,
    title,
    collapseControl,
    actionControl,
    content,
    threadRow,
    emptyState,
  };
}

function dispatchWorkspaceRelations(links: Array<{
  parentProjectId: string;
  childProjectId: string;
  relativePath: string;
  position: number;
}>) {
  window.dispatchEvent(
    new CustomEvent("multi-repo-git:workspace-relations", { detail: { links } }),
  );
}

describe("plugin registrations", () => {
  it("keeps workspace/sidebar and Source Control without a duplicate worktree surface", async () => {
    const app = await loadPluginApp(() => import("../app.js"));
    expect(app.navPanels).toEqual([]);
    expect(app.newThreadPanelActions).toEqual([]);
    expect(app.appOverlays.map((item) => item.id)).toContain("workspace-sidebar-controller");
    expect(app.threadPanelActions.map((item) => item.id)).toContain("source-control");
    expect(app.contentScripts.map((item) => item.id)).toContain("workspace-project-menu");
  }, 60_000);
});

describe("plugin stylesheet lifecycle", () => {
  it("keeps stylesheet disabled for the native sidebar and enables it for Source Control", async () => {
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.dataset.bbPluginCss = "multi-repo-git";
    document.head.append(stylesheet);

    const app = await loadPluginApp(() => import("../app.js"));
    const mounted = await mountPluginContentScripts(app, {
      pluginId: "multi-repo-git",
    });
    expect(stylesheet.media).toBe("not all");

    const overlay = app.appOverlays.find(
      (item) => item.id === "workspace-sidebar-controller",
    )!;
    const sidebar = renderSlot(
      overlay,
      {},
      {
        sidebarThreads: {
          projects: [{ id: "project-root", name: "Root", isPersonal: false }],
        },
        rpc: { workspace_relations: () => ({ links: [] }) },
      },
    );
    expect(stylesheet.media).toBe("not all");

    const action = app.threadPanelActions.find(
      (item) => item.id === "source-control",
    )!;
    const panel = renderSlot(
      action,
      { threadId: "thread-test", params: null },
      {
        rpc: {
          workspace_status: () => ({
            environmentId: "environment-test",
            repositories: [availableRepository()],
            legacyWorktreeSets: [],
          }),
        },
      },
    );
    expect(stylesheet.media).toBe("");
    await panel.findByText("Working tree clean.");
    panel.lifecycle.unmount();
    expect(stylesheet.media).toBe("not all");

    sidebar.lifecycle.unmount();
    await mounted.lifecycle.dispose();
    expect(stylesheet.media).toBe("");
  });
});

describe("workspace collapse persistence", () => {
  it("does not expand a natively collapsed project after mounting", async () => {
    ensureCssEscape();
    const app = await loadPluginApp(() => import("../app.js"));
    const project = createNativeProjectRow({
      projectId: "collapsed-project",
      name: "Collapsed project",
      threadTitle: "Hidden chat",
    });
    project.collapseControl.setAttribute("aria-expanded", "false");
    const collapseClicks = vi.fn();
    project.collapseControl.addEventListener("click", collapseClicks);
    document.body.append(project.row);

    vi.useFakeTimers();
    let sidebar: ReturnType<typeof renderSlot> | null = null;
    try {
      const overlay = app.appOverlays.find(
        (item) => item.id === "workspace-sidebar-controller",
      )!;
      sidebar = renderSlot(
        overlay,
        {},
        {
          sidebarThreads: {
            projects: [
              { id: "collapsed-project", name: "Collapsed project", isPersonal: false },
            ],
          },
          rpc: { workspace_relations: () => ({ links: [] }) },
        },
      );

      await vi.advanceTimersByTimeAsync(20_000);

      expect(project.collapseControl.getAttribute("aria-expanded")).toBe("false");
      expect(collapseClicks).not.toHaveBeenCalled();
    } finally {
      sidebar?.lifecycle.unmount();
      vi.useRealTimers();
    }
  });
});

describe("workspace project menu augmentation", () => {
  it("shares focus-based hover with Radix without leaving two items highlighted", async () => {
    const app = await loadPluginApp(() => import("../app.js"));
    const mounted = await mountPluginContentScripts(app, { pluginId: "multi-repo-git" });
    const project = document.createElement("div");
    project.dataset.sidebarProjectId = "hover-project";
    project.innerHTML = '<button aria-haspopup="menu">Actions</button>';
    document.body.append(project);
    fireEvent.pointerDown(project.querySelector("button")!);
    const view = render(
      <DropdownMenu.Root defaultOpen modal={false}>
        <DropdownMenu.Trigger>Menu</DropdownMenu.Trigger>
        <DropdownMenu.Content>
          <DropdownMenu.Item>Project settings</DropdownMenu.Item>
          <DropdownMenu.Item>Rename</DropdownMenu.Item>
          <DropdownMenu.Item>Remove</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>,
    );
    const menu = view.getByRole("menu");
    await waitFor(() => expect(menu.querySelector("[data-multi-repo-edit-workspace]")).not.toBeNull());
    const workspace = menu.querySelector<HTMLElement>("[data-multi-repo-edit-workspace]")!;
    const settings = view.getByRole("menuitem", { name: "Project settings" });
    const rename = view.getByRole("menuitem", { name: "Rename" });
    // BB's MenuHoverProvider keeps this attribute after Radix focus leaves.
    const hoverStyle = document.createElement("style");
    hoverStyle.textContent = '[data-last-hovered] { background-color: rgb(238, 238, 238); }';
    document.head.append(hoverStyle);
    const pointer = (element: Element, type: string) => {
      const event = new Event(type, { bubbles: true });
      Object.defineProperty(event, "pointerType", { value: "mouse" });
      fireEvent(element, event);
    };
    for (const native of [settings, rename]) {
      pointer(native, "pointermove");
      expect(native.hasAttribute("data-highlighted")).toBe(true);
      settings.removeAttribute("data-last-hovered");
      rename.removeAttribute("data-last-hovered");
      native.setAttribute("data-last-hovered", "");
      expect(getComputedStyle(native).backgroundColor).toBe("rgb(238, 238, 238)");
      pointer(workspace, "pointermove");
      expect(document.activeElement).toBe(workspace);
      expect(native.hasAttribute("data-highlighted")).toBe(false);
      expect(native.hasAttribute("data-last-hovered")).toBe(true);
      expect(menu.hasAttribute("data-multi-repo-workspace-hover")).toBe(true);
      expect(getComputedStyle(native).backgroundColor).toBe("rgba(0, 0, 0, 0)");
      expect(menu.querySelectorAll("[data-highlighted]")).toHaveLength(1);
      pointer(workspace, "pointerout");
      pointer(native, "pointermove");
      expect(workspace.hasAttribute("data-highlighted")).toBe(false);
      expect(menu.hasAttribute("data-multi-repo-workspace-hover")).toBe(false);
      expect(getComputedStyle(native).backgroundColor).toBe("rgb(238, 238, 238)");
      expect(menu.querySelectorAll("[data-highlighted]")).toHaveLength(1);
    }
    pointer(workspace, "pointermove");
    pointer(workspace, "pointerleave");
    expect(document.activeElement).toBe(menu);
    expect(menu.querySelectorAll("[data-highlighted]")).toHaveLength(0);
    await mounted.lifecycle.dispose();
    expect(menu.hasAttribute("data-multi-repo-workspace-hover")).toBe(false);
    hoverStyle.remove();
    view.unmount();
  });

  it.each(["Enter", " "])("supports arrow navigation and %j activation alongside Radix", async (key) => {
    const app = await loadPluginApp(() => import("../app.js"));
    const mounted = await mountPluginContentScripts(app, { pluginId: "multi-repo-git" });
    const project = document.createElement("div");
    project.dataset.sidebarProjectId = "keyboard-project";
    project.innerHTML = '<button aria-haspopup="menu">Actions</button>';
    document.body.append(project);
    fireEvent.pointerDown(project.querySelector("button")!);
    const view = render(
      <DropdownMenu.Root defaultOpen modal={false}>
        <DropdownMenu.Trigger>Menu</DropdownMenu.Trigger>
        <DropdownMenu.Content>
          <DropdownMenu.Item>Project settings</DropdownMenu.Item>
          <DropdownMenu.Item>Rename</DropdownMenu.Item>
          <DropdownMenu.Item>Remove</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>,
    );
    const menu = view.getByRole("menu");
    const listener = vi.fn();
    window.addEventListener("multi-repo-git:edit-workspace", listener);
    try {
      await waitFor(() => expect(menu.querySelector("[data-multi-repo-edit-workspace]")).not.toBeNull());
      const workspace = menu.querySelector<HTMLElement>("[data-multi-repo-edit-workspace]")!;
      const settings = view.getByRole("menuitem", { name: "Project settings" });
      const rename = view.getByRole("menuitem", { name: "Rename" });
      settings.focus();
      fireEvent.keyDown(settings, { key: "ArrowDown" });
      expect(document.activeElement).toBe(workspace);
      fireEvent.keyDown(workspace, { key: "ArrowDown" });
      expect(document.activeElement).toBe(rename);
      fireEvent.keyDown(rename, { key: "ArrowUp" });
      expect(document.activeElement).toBe(workspace);
      fireEvent.keyDown(workspace, { key: "ArrowUp" });
      expect(document.activeElement).toBe(settings);
      fireEvent.keyDown(settings, { key: "ArrowDown" });
      fireEvent.keyDown(workspace, { key });
      expect(listener).toHaveBeenCalledTimes(1);
      expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ projectId: "keyboard-project" });
    } finally {
      window.removeEventListener("multi-repo-git:edit-workspace", listener);
      await mounted.lifecycle.dispose();
      view.unmount();
    }
  });

  it("adds Edit workspace without replacing native project actions", async () => {
    const app = await loadPluginApp(() => import("../app.js"));
    const mounted = await mountPluginContentScripts(app, {
      pluginId: "multi-repo-git",
    });
    const project = document.createElement("div");
    project.dataset.sidebarProjectId = "project-root";
    project.innerHTML = '<button aria-haspopup="menu">Actions</button>';
    document.body.append(project);
    fireEvent.pointerDown(project.querySelector("button")!);

    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.innerHTML =
      '<div role="menuitem" class="native-item">Project settings</div>' +
      '<div role="menuitem" class="native-item">Rename</div>' +
      '<div role="menuitem" class="native-item">Remove</div>';
    document.body.append(menu);

    await waitFor(() => expect(menu.textContent).toContain("Edit workspace"));
    expect(menu.textContent).toContain("Project settings");
    expect(menu.textContent).toContain("Rename");
    expect(menu.textContent).toContain("Remove");
    const workspaceItem = menu.querySelector<HTMLElement>("[data-multi-repo-edit-workspace]")!;
    expect(workspaceItem.className).toBe("native-item");
    expect(workspaceItem.querySelector("svg")?.getAttribute("width")).toBe("16");
    expect(workspaceItem.querySelector("svg")?.getAttribute("height")).toBe("16");
    expect(getComputedStyle(workspaceItem).whiteSpace).toBe("nowrap");
    const listener = vi.fn();
    window.addEventListener("multi-repo-git:edit-workspace", listener);
    fireEvent.click(menu.querySelector("[data-multi-repo-edit-workspace]")!);
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener("multi-repo-git:edit-workspace", listener);
    await mounted.lifecycle.dispose();
  });
});

describe("project chat pagination", () => {
  function addThreads(content: HTMLElement, projectId: string, count: number) {
    content.replaceChildren();
    for (let index = 0; index < count; index++) {
      const wrapper = document.createElement("div");
      wrapper.dataset.sidebarWindowedItem = "";
      // Mix realized rows and the actual native unloaded placeholder contract.
      if (index % 2) {
        wrapper.dataset.sidebarWindowedNav = `${projectId}-${index}:${projectId}`;
        wrapper.style.height = "30px";
      } else {
        const link = document.createElement("a");
        link.dataset.sidebarThreadId = `${projectId}-${index}`;
        link.textContent = `Chat ${index}`;
        link.href = `#${projectId}-${index}`;
        wrapper.append(link);
      }
      content.append(wrapper);
    }
  }
  const shown = (content: HTMLElement) => Array.from(content.querySelectorAll<HTMLElement>(":scope > [data-sidebar-windowed-item]"))
    .filter((element) => !element.hasAttribute("data-multi-repo-chat-hidden"));
  const more = (content: HTMLElement) => content.querySelector<HTMLButtonElement>("[data-multi-repo-more-chats]");

  it("pages stable wrappers independently and resets projects, children and main on collapse", async () => {
    ensureCssEscape();
    const { mountProjectThreadPagination, mountWorkspaceProjectMenu } = await import("../sidebar.js");
    const releaseWorkspace = mountWorkspaceProjectMenu();
    const releasePagination = mountProjectThreadPagination(5);
    const root = createNativeProjectRow({ projectId: "page-root", name: "root" });
    const child = createNativeProjectRow({ projectId: "page-child", name: "child" });
    const ordinary = createNativeProjectRow({ projectId: "page-other", name: "other" });
    for (const fixture of [root, child, ordinary]) {
      addThreads(fixture.content, fixture.row.dataset.sidebarProjectId!, 12);
      document.body.append(fixture.row);
    }
    dispatchWorkspaceRelations([{ parentProjectId: "page-root", childProjectId: "page-child", relativePath: "child", position: 0 }]);
    await waitFor(() => {
      expect(shown(root.content)).toHaveLength(5);
      expect(shown(child.content)).toHaveLength(5);
      expect(shown(ordinary.content)).toHaveLength(5);
    });
    expect(getComputedStyle(root.content.children[5]).display).toBe("none");
    expect(more(root.content)?.textContent).toBe("Show more");
    expect(more(root.content)?.getAttribute("aria-label")).toBe("Show 5 more threads in root");
    fireEvent.click(more(root.content)!);
    fireEvent.click(more(child.content)!);
    await waitFor(() => {
      expect(shown(root.content)).toHaveLength(10);
      expect(shown(child.content)).toHaveLength(10);
    });
    expect(shown(ordinary.content)).toHaveLength(5);
    // Native realization replaces the placeholder contents, not its position.
    const placeholder = root.content.children[7] as HTMLElement;
    delete placeholder.dataset.sidebarWindowedNav;
    placeholder.style.height = "";
    placeholder.innerHTML = '<a data-sidebar-thread-id="page-root-7" href="#7">Realized chat</a>';
    await waitFor(() => expect(shown(root.content)).toHaveLength(10));
    fireEvent.click(more(root.content)!);
    await waitFor(() => expect(shown(root.content)).toHaveLength(12));
    expect(more(root.content)).toBeNull();
    fireEvent.click(child.collapseControl);
    await waitFor(() => expect(shown(child.content)).toHaveLength(5));
    fireEvent.click(child.collapseControl);
    await waitFor(() => expect(more(child.content)).not.toBeNull());
    fireEvent.click(more(child.content)!);
    await waitFor(() => expect(shown(child.content)).toHaveLength(10));
    fireEvent.click(root.collapseControl);
    await waitFor(() => {
      expect(shown(root.content)).toHaveLength(5);
      expect(shown(child.content)).toHaveLength(5);
    });
    fireEvent.click(root.collapseControl);
    await waitFor(() => expect(more(root.content)).not.toBeNull());
    fireEvent.click(more(root.content)!);
    await waitFor(() => expect(shown(root.content)).toHaveLength(10));
    const main = root.row.querySelector<HTMLButtonElement>("[data-multi-repo-main-label]")!;
    fireEvent.click(main);
    await waitFor(() => expect(shown(root.content)).toHaveLength(5));
    fireEvent.click(main);
    await waitFor(() => expect(more(root.content)).not.toBeNull());
    releasePagination();
    expect(root.content.querySelector("[data-multi-repo-chat-hidden]")).toBeNull();
    expect(more(root.content)).toBeNull();
    expect(placeholder.style.height).toBe("");
    releaseWorkspace();
  });

  it("counts only root chats inside native groups, keeping all subthreads with their parent", async () => {
    const { mountProjectThreadPagination } = await import("../sidebar.js");
    const fixture = createNativeProjectRow({ projectId: "tree", name: "tree" });
    fixture.content.innerHTML = '<div data-sidebar-windowed-item><div data-sidebar-sticky-group><div data-sidebar="group-label">Environment</div><div class="tree"></div></div></div>';
    const tree = fixture.content.querySelector<HTMLElement>(".tree")!;
    addThreads(tree, "tree", 7);
    const parent = tree.firstElementChild!;
    const descendants = document.createElement("div");
    addThreads(descendants, "nested", 3);
    parent.append(descendants);
    document.body.append(fixture.row);
    const release = mountProjectThreadPagination(5);
    await waitFor(() => expect(more(fixture.content)).not.toBeNull());
    const visibleLinks = Array.from(fixture.content.querySelectorAll("[data-sidebar-thread-id], [data-sidebar-windowed-nav]"))
      .filter((element) => !element.closest("[data-multi-repo-chat-hidden]"));
    expect(visibleLinks).toHaveLength(8); // Five root chats and three subthreads.
    expect(fixture.content.firstElementChild!.hasAttribute("data-multi-repo-chat-hidden")).toBe(false);
    fireEvent.click(more(fixture.content)!);
    await waitFor(() => expect(more(fixture.content)).toBeNull());
    release();
  });

  it("does not count unloaded subthreads in the native navigation placeholders", async () => {
    const { mountProjectThreadPagination } = await import("../sidebar.js");
    const fixture = createNativeProjectRow({ projectId: "unloaded", name: "unloaded" });
    addThreads(fixture.content, "unloaded", 7);
    const placeholder = fixture.content.children[1] as HTMLElement;
    placeholder.dataset.sidebarWindowedNav = "unloaded-1:unloaded sub-1:unloaded sub-2:unloaded nested:unloaded";
    const release = mountProjectThreadPagination(5, () => new Map([
      ["sub-1", "unloaded-1"], ["sub-2", "unloaded-1"], ["nested", "sub-1"],
    ]));
    document.body.append(fixture.row);
    await waitFor(() => expect(shown(fixture.content)).toHaveLength(5));
    // Realizing the parent and nested children must not change the page count.
    delete placeholder.dataset.sidebarWindowedNav;
    placeholder.innerHTML = '<div><a data-sidebar-thread-id="unloaded-1" href="#1">Parent</a></div><div data-sidebar-windowed-item><a data-sidebar-thread-id="sub-1" href="#sub">Subthread</a></div>';
    await waitFor(() => expect(shown(fixture.content)).toHaveLength(5));
    expect(placeholder.querySelector("[data-multi-repo-chat-hidden]")).toBeNull();
    fireEvent.click(more(fixture.content)!);
    await waitFor(() => expect(more(fixture.content)).toBeNull());
    release();
  });

  it("preserves native collapsed preferences and restores the plugin main state after remount", async () => {
    ensureCssEscape();
    const { mountProjectThreadPagination, mountWorkspaceProjectMenu } = await import("../sidebar.js");
    const root = createNativeProjectRow({ projectId: "persist-root", name: "root" });
    const child = createNativeProjectRow({ projectId: "persist-child", name: "child" });
    document.body.append(root.row, child.row);
    // Native BB owns these values; plugin mount/unmount must not rewrite them.
    localStorage.setItem("bb.sidebar.collapsedProjects", JSON.stringify(["persist-child"]));
    localStorage.setItem("bb.sidebar.collapsedThreads", JSON.stringify(["parent", "subthread"]));
    child.collapseControl.setAttribute("aria-expanded", "false");
    const links = [{ parentProjectId: "persist-root", childProjectId: "persist-child", relativePath: "child", position: 0 }];
    let releaseWorkspace = mountWorkspaceProjectMenu();
    let releasePagination = mountProjectThreadPagination(5);
    dispatchWorkspaceRelations(links);
    await waitFor(() => expect(root.row.querySelector("[data-multi-repo-main-label]")).not.toBeNull());
    fireEvent.click(root.row.querySelector("[data-multi-repo-main-label]")!);
    await waitFor(() => expect(root.content.style.display).toBe("none"));
    releasePagination();
    releaseWorkspace();
    releaseWorkspace = mountWorkspaceProjectMenu();
    releasePagination = mountProjectThreadPagination(5);
    dispatchWorkspaceRelations(links);
    await waitFor(() => {
      expect(root.row.querySelector("[data-multi-repo-main-label]")?.getAttribute("aria-expanded")).toBe("false");
      expect(root.content.style.display).toBe("none");
    });
    expect(child.collapseControl.getAttribute("aria-expanded")).toBe("false");
    expect(JSON.parse(localStorage.getItem("bb.sidebar.collapsedProjects")!)).toEqual(["persist-child"]);
    expect(JSON.parse(localStorage.getItem("bb.sidebar.collapsedThreads")!)).toEqual(["parent", "subthread"]);
    releasePagination();
    releaseWorkspace();
  });

  it("ignores streaming content outside the sidebar and avoids a global hidden-row scan", async () => {
    ensureCssEscape();
    const { mountProjectThreadPagination, mountWorkspaceProjectMenu } = await import("../sidebar.js");
    const fixture = createNativeProjectRow({ projectId: "performance", name: "performance" });
    addThreads(fixture.content, "performance", 100);
    const stream = document.createElement("main");
    document.body.append(fixture.row, stream);
    const contains = vi.spyOn(Element.prototype, "contains");
    const releaseWorkspace = mountWorkspaceProjectMenu();
    const releasePagination = mountProjectThreadPagination(5);
    try {
      await waitFor(() => expect(shown(fixture.content)).toHaveLength(5));
      // Includes jsdom's selector calls; the old global loop exceeds 4,000 calls.
      expect(contains.mock.calls.length).toBeLessThan(1000);
      contains.mockRestore();
      await new Promise((resolve) => setTimeout(resolve, 60));
      const queries = vi.spyOn(document, "querySelectorAll");
      for (let index = 0; index < 5; index++) {
        stream.textContent = `Streaming token ${index}`;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(queries).not.toHaveBeenCalled();
      queries.mockRestore();
      // Relevant native mutations are still picked up without a manual refresh.
      const added = document.createElement("div");
      added.dataset.sidebarWindowedItem = "";
      added.dataset.sidebarWindowedNav = "added:performance";
      fixture.content.prepend(added);
      await waitFor(() => {
        expect(shown(fixture.content)).toHaveLength(5);
        expect(added.hasAttribute("data-multi-repo-chat-hidden")).toBe(false);
        expect(fixture.content.children[5].hasAttribute("data-multi-repo-chat-hidden")).toBe(true);
      });
    } finally {
      vi.restoreAllMocks();
      releasePagination();
      releaseWorkspace();
    }
  });

  it("reads the configured page size from plugin settings", async () => {
    const app = await loadPluginApp(() => import("../app.js"));
    const fixture = createNativeProjectRow({ projectId: "configured", name: "configured" });
    addThreads(fixture.content, "configured", 8);
    document.body.append(fixture.row);
    const registration = app.appOverlays.find((slot) => slot.id === "workspace-sidebar-controller")!;
    const slot = renderSlot(registration, {}, {
      settings: { chatsPerPage: 3 },
      rpc: { workspace_relations: () => ({ links: [] }) },
    });
    await waitFor(() => expect(shown(fixture.content)).toHaveLength(3));
    fireEvent.click(more(fixture.content)!);
    await waitFor(() => expect(shown(fixture.content)).toHaveLength(6));
    slot.lifecycle.unmount();
    expect(shown(fixture.content)).toHaveLength(8);
    expect(more(fixture.content)).toBeNull();
  });
});

describe("workspace sidebar visual hierarchy", () => {
  it("cancels pending decoration when the content script is disposed", async () => {
    ensureCssEscape();
    const { mountWorkspaceProjectMenu } = await import("../sidebar.js");
    const root = createNativeProjectRow({ projectId: "disposed-root", name: "root" });
    const child = createNativeProjectRow({ projectId: "disposed-child", name: "child" });
    document.body.append(root.row, child.row);
    const release = mountWorkspaceProjectMenu();
    dispatchWorkspaceRelations([{ parentProjectId: "disposed-root", childProjectId: "disposed-child", relativePath: "child", position: 0 }]);
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(root.row.querySelector("[data-multi-repo-main-label]")).toBeNull();
    expect(child.row.style.marginLeft).toBe("");
    expect(child.row.hasAttribute("data-multi-repo-workspace-child")).toBe(false);
  });

  it("keeps hierarchy inside independent native project visibility groups", async () => {
    ensureCssEscape();
    const { mountWorkspaceProjectMenu } = await import("../sidebar.js");
    const release = mountWorkspaceProjectMenu();
    const root = createNativeProjectRow({ projectId: "wrapped-root", name: "peptides-main", threadTitle: "Root chat" });
    const child = createNativeProjectRow({ projectId: "wrapped-child", name: "peptides-frontend", threadTitle: "Child chat" });
    const rootWrapper = document.createElement("div");
    rootWrapper.dataset.sidebarVisibilityGroup = "project:wrapped-root";
    rootWrapper.append(root.row);
    const childWrapper = document.createElement("div");
    childWrapper.dataset.sidebarVisibilityGroup = "project:wrapped-child";
    childWrapper.append(child.row);
    document.body.append(rootWrapper, childWrapper);
    dispatchWorkspaceRelations([{ parentProjectId: "wrapped-root", childProjectId: "wrapped-child", relativePath: "peptides-frontend", position: 0 }]);
    await waitFor(() => {
      expect(child.row.dataset.multiRepoWorkspaceChild).toBe("wrapped-root");
      expect(child.row.style.marginLeft).toBe("16px");
      expect(child.content.style.marginLeft).toBe("8px");
    });
    expect(root.row.parentElement).toBe(rootWrapper);
    expect(child.row.parentElement).toBe(childWrapper);
    expect(childWrapper.dataset.sidebarVisibilityGroup).toBe("project:wrapped-child");
    fireEvent.click(root.collapseControl);
    await waitFor(() => expect(child.row.style.display).toBe("none"));
    fireEvent.click(root.collapseControl);
    await waitFor(() => expect(child.row.style.display).toBe(""));
    expect(child.row.style.marginLeft).toBe("16px");
    fireEvent.click(child.collapseControl);
    await waitFor(() => expect(child.row.dataset.multiRepoWorkspaceChild).toBe("wrapped-root"));
    expect(child.row.style.marginLeft).toBe("16px");
    release();
    expect(child.row.style.marginLeft).toBe("");
    expect(child.row.parentElement).toBe(childWrapper);
  });

  it("matches main to a native child heading and indents both content subtrees", async () => {
    ensureCssEscape();
    const app = await loadPluginApp(() => import("../app.js"));
    const mounted = await mountPluginContentScripts(app, {
      pluginId: "multi-repo-git",
    });
    const root = createNativeProjectRow({
      projectId: "root-project",
      name: "root",
      threadTitle: "Root chat",
    });
    const child = createNativeProjectRow({
      projectId: "child-project",
      name: "frontend",
      threadTitle: "Child chat",
    });
    const emptyChild = createNativeProjectRow({
      projectId: "empty-project",
      name: "backend",
    });
    const ordinary = createNativeProjectRow({
      projectId: "ordinary-project",
      name: "ordinary",
      threadTitle: "Ordinary chat",
    });
    const rootThread = root.threadRow!;
    document.body.append(root.row, child.row, emptyChild.row, ordinary.row);

    dispatchWorkspaceRelations([
      {
        parentProjectId: "root-project",
        childProjectId: "child-project",
        relativePath: "frontend",
        position: 0,
      },
      {
        parentProjectId: "root-project",
        childProjectId: "empty-project",
        relativePath: "backend",
        position: 1,
      },
    ]);

    await waitFor(() =>
      expect(root.row.dataset.multiRepoWorkspaceRoot).toBe(""),
    );
    const mainLabel = root.row.querySelector<HTMLButtonElement>(
      "[data-multi-repo-main-label]",
    );
    expect(mainLabel).not.toBeNull();
    expect(mainLabel!.className).toBe(child.heading.className);
    expect(
      mainLabel!.querySelector("[data-multi-repo-main-label-title]")?.className,
    ).toBe(child.title.className);
    expect(
      mainLabel!.querySelector("[data-multi-repo-main-chevron-control]")?.className,
    ).toBe(child.collapseControl.className);
    expect(
      mainLabel!.querySelector("[data-multi-repo-main-chevron]")?.classList.contains(
        "rotate-90",
      ),
    ).toBe(true);
    expect(mainLabel!.style.cssText).not.toContain("border-left");

    expect(root.content.style.marginLeft).toBe("24px");
    expect(root.content.style.width).toBe("calc(100% - 24px)");
    expect(child.row.style.marginLeft).toBe("16px");
    expect(child.content.style.marginLeft).toBe("8px");
    expect(child.content.style.width).toBe("calc(100% - 8px)");
    expect(emptyChild.content.style.marginLeft).toBe("8px");
    expect(emptyChild.emptyState).not.toBeNull();
    expect(rootThread.style.fontSize).toBe("13px");
    expect(root.threadRow).toBe(rootThread);
    expect(ordinary.row.dataset.multiRepoWorkspaceRoot).toBeUndefined();
    expect(ordinary.row.dataset.multiRepoWorkspaceChild).toBeUndefined();
    expect(ordinary.content.style.marginLeft).toBe("");

    await mounted.lifecycle.dispose();
  });

  it("preserves native interactions and restores pre-existing styles on removal and dispose", async () => {
    ensureCssEscape();
    const app = await loadPluginApp(() => import("../app.js"));
    const mounted = await mountPluginContentScripts(app, {
      pluginId: "multi-repo-git",
    });
    const root = createNativeProjectRow({
      projectId: "restore-root",
      name: "root",
      threadTitle: "Root chat",
    });
    const child = createNativeProjectRow({
      projectId: "restore-child",
      name: "frontend",
      threadTitle: "Child chat",
    });
    root.content.style.setProperty("margin-left", "3px", "important");
    root.content.style.width = "calc(100% - 3px)";
    child.row.style.marginLeft = "5px";
    child.row.style.width = "calc(100% - 5px)";
    child.row.style.marginBlockStart = "7px";
    child.content.style.marginLeft = "9px";
    child.content.style.width = "calc(100% - 9px)";
    const menuClick = vi.fn();
    const threadClick = vi.fn();
    const pointerDown = vi.fn();
    child.actionControl.addEventListener("click", menuClick);
    child.threadRow!.addEventListener("click", threadClick);
    child.threadRow!.addEventListener("pointerdown", pointerDown);
    document.body.append(root.row, child.row);

    const links = [{
      parentProjectId: "restore-root",
      childProjectId: "restore-child",
      relativePath: "frontend",
      position: 0,
    }];
    dispatchWorkspaceRelations(links);
    await waitFor(() =>
      expect(root.row.dataset.multiRepoWorkspaceRoot).toBe(""),
    );

    const mainLabel = root.row.querySelector<HTMLButtonElement>(
      "[data-multi-repo-main-label]",
    )!;
    fireEvent.click(mainLabel);
    await waitFor(() => expect(root.content.style.display).toBe("none"));
    expect(mainLabel.getAttribute("aria-expanded")).toBe("false");
    expect(
      mainLabel.querySelector("[data-multi-repo-main-chevron]")?.classList.contains(
        "rotate-90",
      ),
    ).toBe(false);
    expect(child.row.style.display).not.toBe("none");

    fireEvent.click(child.actionControl);
    fireEvent.click(child.collapseControl);
    fireEvent.pointerDown(child.threadRow!);
    fireEvent.click(child.threadRow!);
    expect(menuClick).toHaveBeenCalledOnce();
    expect(child.collapseControl.getAttribute("aria-expanded")).toBe("false");
    expect(pointerDown).toHaveBeenCalledOnce();
    expect(threadClick).toHaveBeenCalledOnce();

    dispatchWorkspaceRelations([]);
    await waitFor(() =>
      expect(root.row.dataset.multiRepoWorkspaceRoot).toBeUndefined(),
    );
    expect(root.content.style.getPropertyValue("margin-left")).toBe("3px");
    expect(root.content.style.getPropertyPriority("margin-left")).toBe("important");
    expect(root.content.style.width).toBe("calc(100% - 3px)");
    expect(root.content.style.display).toBe("");
    expect(child.row.style.marginLeft).toBe("5px");
    expect(child.row.style.width).toBe("calc(100% - 5px)");
    expect(child.row.style.marginBlockStart).toBe("7px");
    expect(child.content.style.marginLeft).toBe("9px");
    expect(child.content.style.width).toBe("calc(100% - 9px)");
    expect(root.row.querySelector("[data-multi-repo-main-label]")).toBeNull();

    dispatchWorkspaceRelations(links);
    await waitFor(() =>
      expect(root.row.dataset.multiRepoWorkspaceRoot).toBe(""),
    );
    await mounted.lifecycle.dispose();
    expect(root.content.style.getPropertyValue("margin-left")).toBe("3px");
    expect(root.content.style.getPropertyPriority("margin-left")).toBe("important");
    expect(child.row.style.marginLeft).toBe("5px");
    expect(child.content.style.marginLeft).toBe("9px");
    expect(root.row.querySelector("[data-multi-repo-main-label]")).toBeNull();
  });

  it("leaves an incompatible native row unmodified", async () => {
    ensureCssEscape();
    const app = await loadPluginApp(() => import("../app.js"));
    const mounted = await mountPluginContentScripts(app, {
      pluginId: "multi-repo-git",
    });
    const root = createNativeProjectRow({
      projectId: "broken-root",
      name: "broken root",
      threadTitle: "Root chat",
    });
    const child = createNativeProjectRow({
      projectId: "broken-child",
      name: "child",
      threadTitle: "Child chat",
    });
    root.collapseControl.querySelector("svg")?.removeAttribute("data-icon");
    document.body.append(root.row, child.row);

    dispatchWorkspaceRelations([{
      parentProjectId: "broken-root",
      childProjectId: "broken-child",
      relativePath: "child",
      position: 0,
    }]);

    await new Promise((resolve) => window.setTimeout(resolve, 25));
    expect(root.row.dataset.multiRepoWorkspaceRoot).toBeUndefined();
    expect(child.row.dataset.multiRepoWorkspaceChild).toBeUndefined();
    expect(root.row.querySelector("[data-multi-repo-main-label]")).toBeNull();
    expect(root.content.style.marginLeft).toBe("");
    expect(child.content.style.marginLeft).toBe("");

    await mounted.lifecycle.dispose();
  });

  it("emits zero DOM mutations when reconcile reruns without changes", async () => {
    ensureCssEscape();
    const app = await loadPluginApp(() => import("../app.js"));
    const mounted = await mountPluginContentScripts(app, {
      pluginId: "multi-repo-git",
    });
    const root = createNativeProjectRow({
      projectId: "idle-root",
      name: "root",
      threadTitle: "Root chat",
    });
    const child = createNativeProjectRow({
      projectId: "idle-child",
      name: "frontend",
      threadTitle: "Child chat",
    });
    document.body.append(root.row, child.row);

    const links = [{
      parentProjectId: "idle-root",
      childProjectId: "idle-child",
      relativePath: "frontend",
      position: 0,
    }];
    dispatchWorkspaceRelations(links);
    await waitFor(() =>
      expect(root.row.dataset.multiRepoWorkspaceRoot).toBe(""),
    );
    // Let any follow-up decoration pass triggered by the plugin's own
    // MutationObserver settle before counting mutations.
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    await new Promise((resolve) => window.setTimeout(resolve, 25));

    const records: MutationRecord[] = [];
    const counting = new MutationObserver((batch) => records.push(...batch));
    counting.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });

    // Repeat the identical relations payload: reconcile must be a no-op.
    dispatchWorkspaceRelations(links);
    dispatchWorkspaceRelations(links);
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    await new Promise((resolve) => window.setTimeout(resolve, 25));

    // Simulate unrelated idle churn inside the sidebar subtree (a native
    // re-render): the observer-driven reconcile still must not write.
    const noise = document.createElement("span");
    noise.textContent = "idle";
    child.threadRow!.append(noise);
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    noise.remove();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    await new Promise((resolve) => window.setTimeout(resolve, 25));

    counting.disconnect();
    const pluginCaused = records.filter((record) => {
      if (record.type !== "childList") return true;
      const isNoise = (nodes: NodeList) =>
        nodes.length === 1 && nodes[0] === noise;
      return !isNoise(record.addedNodes) && !isNoise(record.removedNodes);
    });
    expect(pluginCaused).toEqual([]);

    // Decorations stay intact after the no-op reconciles.
    expect(root.row.dataset.multiRepoWorkspaceRoot).toBe("");
    expect(child.row.dataset.multiRepoWorkspaceChild).toBe("idle-root");
    expect(root.content.style.marginLeft).toBe("24px");
    expect(child.row.style.marginLeft).toBe("16px");
    expect(
      root.row.querySelector("[data-multi-repo-main-label]"),
    ).not.toBeNull();

    await mounted.lifecycle.dispose();
  }, 30_000);
});

describe("workspace folder picker", () => {
  it("edits explicit membership without replacing the native thread list", async () => {
    const app = await loadPluginApp(() => import("../app.js"));
    const registration = app.appOverlays.find((item) => item.id === "workspace-sidebar-controller")!;
    const slot = renderSlot(
      registration,
      {},
      {
        sidebarThreads: {
          projects: [{ id: "project-root", name: "Root", isPersonal: false }],
        },
        rpc: {
          workspace_relations: () => ({ links: [] }),
          workspace_config: () => ({
            rootProjectId: "project-root",
            enabled: true,
            children: [{
              projectId: "backend-project",
              name: "backend",
              relativePath: "backend",
              position: 0,
              available: true,
            }],
          }),
          workspace_update_folders: () => ({
            rootProjectId: "project-root",
            enabled: true,
            children: [{
              projectId: "docs-project",
              name: "docs",
              relativePath: "docs",
              position: 0,
              available: true,
            }],
          }),
          workspace_folder_browser: () => ({
            projectId: "project-root",
            currentPath: ".",
            parentPath: null,
            folders: [
              { name: "backend", relativePath: "backend", hasChildren: false, isGitRepository: true, connected: true },
              { name: "docs", relativePath: "docs", hasChildren: false, isGitRepository: false, connected: false },
            ],
          }),
        },
      },
    );
    fireEvent(window, new CustomEvent("multi-repo-git:edit-workspace", {
      detail: { projectId: "project-root" },
    }));
    await slot.findByRole("dialog", { name: "Edit workspace" });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(slot.getByRole("checkbox", { name: "Select backend" }));
    fireEvent.click(slot.getByRole("checkbox", { name: "Select docs" }));
    fireEvent.click(slot.getByRole("button", { name: "Update workspace" }));
    await waitFor(() => expect(slot.inspection.rpcCalls).toContainEqual({
      method: "workspace_update_folders",
      input: { parentProjectId: "project-root", relativePaths: ["docs"] },
    }));
    expect(confirm).toHaveBeenCalledOnce();
    confirm.mockRestore();
    slot.lifecycle.unmount();
  });
});

describe("Source Control thread panel", () => {
  it("reports scan deadlines as load failures, permits retry and keeps the last successful snapshot", async () => {
    const app = await loadPluginApp(() => import("../app.js"));
    const action = app.threadPanelActions.find((item) => item.id === "source-control")!;
    const snapshot = {
      environmentId: "environment-deadline",
      repositories: [availableRepository()], legacyWorktreeSets: [],
    };
    const deadline = new Error("host plugin call test-id exceeded its deadline");
    const status = vi.fn().mockRejectedValueOnce(deadline).mockResolvedValueOnce(snapshot)
      .mockRejectedValueOnce(deadline).mockResolvedValueOnce({
        ...snapshot, repositories: [{ ...availableRepository(), branch: "retry-restored" }],
      });
    const props = { threadId: "thread-deadline", params: null };
    const first = renderSlot(action, props, { rpc: { workspace_status: status } });
    await first.findByText(/Repository scan timed out/);
    expect(first.queryByText("Repositories not found.")).toBeNull();
    expect(first.queryByText(/host plugin call/)).toBeNull();
    expect(first.getByText(/Repository status could not be loaded/)).toBeTruthy();
    fireEvent.click(first.getByRole("button", { name: "Refresh repositories" }));
    await first.findByText("Working tree clean.");
    first.lifecycle.unmount();

    const failedRefresh = renderSlot(action, props, { rpc: { workspace_status: status } });
    await failedRefresh.findByText(/Repository scan timed out/);
    expect(failedRefresh.getByText("umbrella")).toBeTruthy();
    expect((failedRefresh.getByRole("button", { name: /Push/ }) as HTMLButtonElement).disabled).toBe(true);
    failedRefresh.lifecycle.unmount();

    const returned = renderSlot(action, props, { rpc: { workspace_status: status } });
    expect(returned.getByText("umbrella")).toBeTruthy();
    expect(returned.queryByText("Scanning repositories…")).toBeNull();
    await returned.findByText("retry-restored");
    expect((returned.getByRole("button", { name: /Push/ }) as HTMLButtonElement).disabled).toBe(false);
    returned.lifecycle.unmount();
  });

  it("restores the selected repository immediately after a file-preview remount and revalidates safely", async () => {
    const app = await loadPluginApp(() => import("../app.js"));
    const action = app.threadPanelActions.find((item) => item.id === "source-control")!;
    const snapshot = {
      environmentId: "environment-return",
      repositories: [availableRepository(), availableRepository("packages/child")],
      legacyWorktreeSets: [],
    };
    let resolveRefresh!: (value: typeof snapshot) => void;
    const pending = new Promise<typeof snapshot>((resolve) => { resolveRefresh = resolve; });
    const status = vi.fn().mockResolvedValueOnce(snapshot).mockReturnValueOnce(pending);
    const props = { threadId: "thread-file-return", params: null };
    const first = renderSlot(action, props, { rpc: { workspace_status: status } });
    fireEvent.click(await first.findByRole("button", { name: /child/ }));
    await waitFor(() => expect(first.getByRole("button", { name: /child/ }).getAttribute("aria-pressed")).toBe("true"));
    first.lifecycle.unmount();

    const returned = renderSlot(action, props, { rpc: { workspace_status: status } });
    expect(returned.queryByText("Scanning repositories…")).toBeNull();
    expect(returned.getByRole("button", { name: /child/ }).getAttribute("aria-pressed")).toBe("true");
    expect((returned.getByRole("button", { name: /Push/ }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    resolveRefresh({ ...snapshot, repositories: snapshot.repositories.map((repo) => ({ ...repo, branch: "fresh-branch" })) });
    await returned.findByText("fresh-branch");
    expect((returned.getByRole("button", { name: /Push/ }) as HTMLButtonElement).disabled).toBe(false);
    returned.lifecycle.unmount();

    // A different chat must not receive the previous chat's cached workspace.
    const other = renderSlot(action, { threadId: "thread-other-return", params: null }, {
      rpc: { workspace_status: () => Promise.reject(new Error("other workspace offline")) },
    });
    expect(other.queryByText("child")).toBeNull();
    await other.findByText("other workspace offline");
    other.lifecycle.unmount();
  });

  it("reuses a pending scan across file-preview remounts and allows retry after failure", async () => {
    const app = await loadPluginApp(() => import("../app.js"));
    const action = app.threadPanelActions.find((item) => item.id === "source-control")!;
    let rejectScan!: (cause: Error) => void;
    const pending = new Promise<never>((_, reject) => { rejectScan = reject; });
    const status = vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce({
      environmentId: "environment-pending",
      repositories: [availableRepository()], legacyWorktreeSets: [],
    });
    const props = { threadId: "thread-pending-return", params: null };
    const first = renderSlot(action, props, { rpc: { workspace_status: status } });
    await waitFor(() => expect(status).toHaveBeenCalledTimes(1));
    first.lifecycle.unmount();
    const returned = renderSlot(action, props, { rpc: { workspace_status: status } });
    expect(status).toHaveBeenCalledTimes(1);
    rejectScan(new Error("scan failed"));
    await returned.findByText("scan failed");
    fireEvent.click(returned.getByRole("button", { name: "Refresh repositories" }));
    await returned.findByText("Working tree clean.");
    expect(status).toHaveBeenCalledTimes(2);
    expect(returned.queryByText("scan failed")).toBeNull();
    returned.lifecycle.unmount();
  });

  it("renders an available environment-local repository", async () => {
    const app = await loadPluginApp(() => import("../app.js"));
    const action = app.threadPanelActions.find((item) => item.id === "source-control")!;
    const slot = renderSlot(
      action,
      { threadId: "thread-test", params: null },
      { rpc: { workspace_status: () => ({
        environmentId: "environment-test",
        repositories: [availableRepository()],
        legacyWorktreeSets: [],
      }) } },
    );
    await slot.findByText("umbrella");
    await slot.findByText("Working tree clean.");
    expect(slot.inspection.rpcCalls).toEqual([{
      method: "workspace_status",
      input: { threadId: "thread-test" },
    }]);
    slot.lifecycle.unmount();
  });

  it("shows missing explicit members with setup guidance and no mutation controls", async () => {
    const app = await loadPluginApp(() => import("../app.js"));
    const action = app.threadPanelActions.find((item) => item.id === "source-control")!;
    const slot = renderSlot(
      action,
      { threadId: "thread-test", params: null },
      { rpc: { workspace_status: () => ({
        environmentId: "environment-test",
        repositories: [{
          ...availableRepository("packages/missing"),
          projectId: "project-missing",
          name: "missing",
          available: false,
          unavailableReason: "missing",
          error: "ENOENT",
          branch: null,
          detached: true,
          head: null,
          upstream: null,
        }],
        legacyWorktreeSets: [],
      }) } },
    );
    await slot.findByText("Repository unavailable in this environment");
    expect(slot.getByText(/\.bb-env-setup\.sh/)).toBeTruthy();
    expect(slot.queryByText("Commit staged changes")).toBeNull();
    expect(slot.queryByRole("button", { name: /Push/ })).toBeNull();
    slot.lifecycle.unmount();
  });

  it("renders legacy worktree records as a read-only notice", async () => {
    const app = await loadPluginApp(() => import("../app.js"));
    const action = app.threadPanelActions.find((item) => item.id === "source-control")!;
    const slot = renderSlot(
      action,
      { threadId: "thread-test", params: null },
      { rpc: { workspace_status: () => ({
        environmentId: "environment-test",
        repositories: [availableRepository()],
        legacyWorktreeSets: [{
          id: "set-legacy",
          hostId: "host-legacy",
          lifecycleStatus: "partial",
          members: [{
            worktreePath: "/legacy/worktrees/root",
            taskBranch: "task/legacy",
            materializationStatus: "failed",
            mergeStatus: "pending",
            removalStatus: "pending",
          }],
        }],
      }) } },
    );
    fireEvent.click(await slot.findByText("Legacy unmanaged worktrees (1)"));
    await slot.findByText("set-legacy");
    await slot.findByText("/legacy/worktrees/root");
    expect(slot.getByText(/BB will not clean them up/)).toBeTruthy();
    expect(slot.queryByRole("button", { name: /Remove worktree/i })).toBeNull();
    slot.lifecycle.unmount();
  });
});
