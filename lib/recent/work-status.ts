import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

const workIndicators = new Set(["runtime", "working-draft", "workflow", "background-agent", "background-command", "plan-mode", "goal"]);

/** Include work in descendants even when they have no saved message in Recent. */
export function workingThreadIds(threads: ReadonlyMap<string, PluginSidebarThread>): Set<string> {
  const working = new Set<string>();
  for (const thread of threads.values()) {
    if (thread.isArchived) continue;
    const running = !thread.hasPendingInteraction && thread.indicator !== "waiting-for-input"
      && ["active", "provisioning", "starting", "stopping"].includes(thread.runtimeStatus);
    if (running || Object.values(thread.activity).some(count => count > 0) || workIndicators.has(thread.indicator)) working.add(thread.id);
  }
  const pending = [...working];
  // Each id is queued once: cycles cannot loop and shared ancestors are not rescanned.
  for (let index = 0; index < pending.length; index++) {
    const thread = threads.get(pending[index])!;
    const parents = [thread.parentThreadId,
      thread.isHidden && thread.originKind === "fork" ? thread.sourceThreadId : null];
    for (const id of parents) {
      if (!id || working.has(id)) continue;
      const parent = threads.get(id);
      if (!parent || parent.isArchived) continue;
      working.add(id); pending.push(id);
    }
  }
  return working;
}
