import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_Diff as Diff,
  experimental_FileLink as FileLink,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type {
  DiffResult,
  FileChange,
  LegacyWorktreeSet,
  RepositoryStatus,
  WorkspaceStatus,
} from "./contract";
import type { rpcContract } from "./contract";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { WorkspaceSidebarController, mountWorkspaceProjectMenu } from "./sidebar.js";
import {
  mountLazyPluginStylesheet,
  usePluginStylesheet,
} from "./stylesheet.js";

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function workspaceFilePath(repositoryPath: string, filePath: string): string {
  return repositoryPath === "." ? filePath : `${repositoryPath}/${filePath}`;
}

function statusText(file: FileChange): string {
  if (file.untracked) return "U";
  if (file.conflicted) return "!";
  const parts: string[] = [];
  if (file.staged) parts.push(file.indexStatus);
  if (file.unstaged) parts.push(file.worktreeStatus);
  return parts.join("/") || "?";
}

function RepoSummary({ repository }: { repository: RepositoryStatus }) {
  const detail = repository.available
    ? `${repository.relativePath} · ${repository.branch ?? `detached@${repository.head ?? "unknown"}`}`
    : `${repository.relativePath} · unavailable`;
  return (
    <span className="min-w-0 flex-1 text-left">
      <span className="block truncate font-medium">{repository.name}</span>
      <span className="block truncate font-mono text-[11px] text-muted-foreground">
        {detail}
      </span>
    </span>
  );
}

function RepositoryPicker({
  repositories,
  selected,
  onSelect,
}: {
  repositories: RepositoryStatus[];
  selected: string;
  onSelect: (path: string) => void;
}) {
  return (
    <div className="space-y-1 border-b border-border p-2">
      {repositories.map((repository) => (
        <button
          key={`${repository.projectId ?? "ordinary"}:${repository.relativePath}`}
          type="button"
          onClick={() => onSelect(repository.relativePath)}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-sm hover:bg-state-hover",
            selected === repository.relativePath && "bg-state-active",
          )}
          aria-pressed={selected === repository.relativePath}
        >
          <Icon name="FolderGit" className="size-4 shrink-0 text-muted-foreground" />
          <RepoSummary repository={repository} />
          {repository.available ? (
            <span className={cn(
              "rounded-full px-1.5 py-0.5 text-[10px] tabular-nums",
              repository.files.length > 0
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground",
            )}>
              {repository.files.length}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function LegacyWorktreeNotice({ sets }: { sets: LegacyWorktreeSet[] }) {
  if (sets.length === 0) return null;
  return (
    <details className="border-b border-border bg-secondary/40 px-3 py-2 text-xs">
      <summary className="cursor-pointer font-medium">
        Legacy unmanaged worktrees ({sets.length})
      </summary>
      <p className="mt-2 text-muted-foreground">
        These paths were created by an older plugin version. They are read-only
        here and BB will not clean them up. Inspect and reconcile them manually.
      </p>
      <ul className="mt-2 space-y-2">
        {sets.map((set) => (
          <li key={set.id} className="rounded-md border border-border bg-background p-2">
            <div className="font-mono break-all">{set.id}</div>
            <div className="text-muted-foreground">
              Host {set.hostId} · {set.lifecycleStatus}
            </div>
            <ul className="mt-1 space-y-1">
              {set.members.map((member) => (
                <li key={`${member.worktreePath}:${member.taskBranch}`}>
                  <span className="font-mono break-all">{member.worktreePath}</span>
                  <span className="block text-muted-foreground">
                    {member.taskBranch} · materialize {member.materializationStatus} ·
                    merge {member.mergeStatus} · removal {member.removalStatus}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </details>
  );
}

function FileRow({
  file,
  repository,
  environmentId,
  selected,
  busy,
  onSelectedChange,
  onDiff,
  onStage,
  onUnstage,
}: {
  file: FileChange;
  repository: RepositoryStatus;
  environmentId: string;
  selected: boolean;
  busy: boolean;
  onSelectedChange: (selected: boolean) => void;
  onDiff: (staged: boolean) => void;
  onStage: () => void;
  onUnstage: () => void;
}) {
  return (
    <li className="border-b border-border px-3 py-2.5 last:border-b-0">
      <div className="flex min-w-0 items-start gap-2">
        <Checkbox
          checked={selected}
          onCheckedChange={(value) => onSelectedChange(value === true)}
          aria-label={`Select ${file.path}`}
          className="mt-0.5"
        />
        <div className="min-w-0 flex-1">
          <FileLink
            target={{
              kind: "workspace",
              environmentId,
              path: workspaceFilePath(repository.relativePath, file.path),
            }}
            className="block truncate text-sm font-medium hover:underline"
          >
            {file.path}
          </FileLink>
          {file.originalPath === null ? null : (
            <span className="block truncate text-[11px] text-muted-foreground">
              from {file.originalPath}
            </span>
          )}
        </div>
        <span
          className={cn(
            "rounded px-1.5 py-0.5 font-mono text-[10px]",
            file.conflicted
              ? "bg-destructive/15 text-destructive"
              : "bg-secondary text-secondary-foreground",
          )}
          title={`Index: ${file.indexStatus}; worktree: ${file.worktreeStatus}`}
        >
          {statusText(file)}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-1 pl-7">
        {file.unstaged ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => onDiff(false)}>
              <Icon name="FileDiff" /> Working diff
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={onStage}>
              Stage
            </Button>
          </>
        ) : null}
        {file.staged ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => onDiff(true)}>
              <Icon name="FileDiff" /> Staged diff
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={onUnstage}>
              Unstage
            </Button>
          </>
        ) : null}
      </div>
    </li>
  );
}

function unavailableGuidance(repository: RepositoryStatus): string {
  switch (repository.unavailableReason) {
    case "missing":
      return "Configure the root project to materialize this explicit member through a submodule, .bb-env-setup.sh, or .worktreeinclude.";
    case "not_repository":
      return "The configured path exists but is not a Git repository root. Fix the project setup or workspace member path.";
    case "outside_workspace":
      return "The configured path does not resolve safely inside this BB environment.";
    default:
      return "The repository cannot be inspected in this environment. Check project provisioning and host access.";
  }
}

interface SourceControlSession {
  threadId: string;
  status: WorkspaceStatus | null;
  selectedRepository: string;
  pending: Promise<WorkspaceStatus> | null;
}

// ponytail: retain only the latest thread; use a bounded per-thread cache if cross-thread returns need it.
let sourceControlSession: SourceControlSession | null = null;

function SourceControlPanel({ threadId }: { threadId: string }) {
  return <SourceControlContent key={threadId} threadId={threadId} />;
}

function SourceControlContent({ threadId }: { threadId: string }) {
  usePluginStylesheet();
  const rpc = useRpc<typeof rpcContract>();
  const [session] = useState(() => {
    if (sourceControlSession?.threadId !== threadId) {
      sourceControlSession = { threadId, status: null, selectedRepository: ".", pending: null };
    }
    return sourceControlSession;
  });
  const requestSequence = useRef(0);
  const [status, setStatus] = useState<WorkspaceStatus | null>(session.status);
  const [selectedRepository, setSelectedRepository] = useState(session.selectedRepository);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(() => new Set());
  const [diffTarget, setDiffTarget] = useState<{ path: string; staged: boolean } | null>(null);
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [branchName, setBranchName] = useState("");

  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setLoading(true);
    try {
      session.pending ??= rpc.call("workspace_status", { threadId }).then((next) => {
        session.status = next;
        return next;
      }).finally(() => { session.pending = null; });
      const next = await session.pending;
      if (sequence !== requestSequence.current) return;
      setStatus(next);
      setError(null);
      setSelectedRepository((current) =>
        next.repositories.some((repository) => repository.relativePath === current)
          ? current
          : (next.repositories[0]?.relativePath ?? "."),
      );
    } catch (cause) {
      if (sequence === requestSequence.current) {
        const message = errorMessage(cause);
        setError(message.includes("exceeded its deadline")
          ? "Repository scan timed out. The host may be busy. Retry using Refresh repositories."
          : message);
      }
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }, [rpc, session, threadId]);

  useEffect(() => {
    void refresh();
    return () => { requestSequence.current++; };
  }, [refresh]);
  useEffect(() => { session.selectedRepository = selectedRepository; }, [selectedRepository, session]);
  const mutationsBlocked = busy || loading || error !== null;
  useEffect(() => {
    setSelectedFiles(new Set());
    setDiffTarget(null);
    setDiff(null);
    setCommitMessage("");
    setBranchName("");
  }, [selectedRepository]);

  const repository = useMemo(
    () => status?.repositories.find(
      (candidate) => candidate.relativePath === selectedRepository,
    ) ?? null,
    [selectedRepository, status],
  );

  const runMutation = useCallback(async (operation: () => Promise<{ message: string }>) => {
    setBusy(true);
    try {
      const result = await operation();
      toast.success(result.message.split("\n")[0] || "Git operation completed.");
      setSelectedFiles(new Set());
      setDiffTarget(null);
      setDiff(null);
      await refresh();
    } catch (cause) {
      const message = errorMessage(cause);
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const loadDiff = useCallback(async (filePath: string, staged: boolean) => {
    if (repository === null || !repository.available) return;
    setDiffTarget({ path: filePath, staged });
    setDiff(null);
    try {
      setDiff(await rpc.call("file_diff", {
        threadId,
        repositoryPath: repository.relativePath,
        filePath,
        staged,
      }));
    } catch (cause) {
      const message = errorMessage(cause);
      setError(message);
      toast.error(message);
    }
  }, [repository, rpc, threadId]);

  if (status === null && loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Icon name="Loading" className="mr-2 size-4 animate-spin" /> Scanning repositories…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div>
          <p className="text-sm font-medium">Source Control</p>
          <p className="text-[11px] text-muted-foreground">
            Explicit repositories in this BB environment
          </p>
        </div>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => void refresh()}
          disabled={loading || busy}
          aria-label="Refresh repositories"
        >
          <Icon name="RotateCcw" className={cn(loading && "animate-spin")} />
        </Button>
      </div>

      <LegacyWorktreeNotice sets={status?.legacyWorktreeSets ?? []} />

      {error === null ? null : (
        <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {status === null ? null : (
        <RepositoryPicker
          repositories={status.repositories}
          selected={selectedRepository}
          onSelect={setSelectedRepository}
        />
      )}

      {repository === null ? (
        <div className="p-4 text-sm text-muted-foreground">
          {error === null ? "Repositories not found." : "Repository status could not be loaded. Retry using Refresh repositories."}
        </div>
      ) : !repository.available ? (
        <div className="p-4">
          <p className="text-sm font-medium">Repository unavailable in this environment</p>
          <p className="mt-1 break-words font-mono text-xs text-muted-foreground">
            {repository.relativePath}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {unavailableGuidance(repository)}
          </p>
          {repository.error ? (
            <p className="mt-2 break-words text-xs text-muted-foreground">{repository.error}</p>
          ) : null}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="border-b border-border px-3 py-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="rounded bg-secondary px-2 py-1 font-mono text-secondary-foreground">
                {repository.branch ?? `detached@${repository.head ?? "unknown"}`}
              </span>
              {repository.upstream === null ? null : <span>{repository.upstream}</span>}
              {repository.ahead > 0 ? <span>↑ {repository.ahead}</span> : null}
              {repository.behind > 0 ? <span>↓ {repository.behind}</span> : null}
            </div>
            {repository.detached ? (
              <div className="mt-3 flex gap-2">
                <Input
                  value={branchName}
                  onChange={(event) => setBranchName(event.target.value)}
                  placeholder="feature/my-branch"
                  aria-label="New branch name"
                />
                <Button
                  size="sm"
                  disabled={mutationsBlocked || branchName.trim() === ""}
                  onClick={() => void runMutation(() => rpc.call("create_branch", {
                    threadId,
                    repositoryPath: repository.relativePath,
                    branch: branchName.trim(),
                  }))}
                >
                  Create branch
                </Button>
              </div>
            ) : null}
          </div>

          <div className="border-b border-border px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Changes ({repository.files.length})
              </p>
              {selectedFiles.size > 0 ? (
                <div className="flex gap-1">
                  <Button size="sm" variant="outline" disabled={mutationsBlocked} onClick={() =>
                    void runMutation(() => rpc.call("stage_files", {
                      threadId,
                      repositoryPath: repository.relativePath,
                      paths: [...selectedFiles],
                    }))
                  }>
                    Stage {selectedFiles.size}
                  </Button>
                  <Button size="sm" variant="outline" disabled={mutationsBlocked} onClick={() =>
                    void runMutation(() => rpc.call("unstage_files", {
                      threadId,
                      repositoryPath: repository.relativePath,
                      paths: [...selectedFiles],
                    }))
                  }>
                    Unstage {selectedFiles.size}
                  </Button>
                </div>
              ) : null}
            </div>
          </div>

          {repository.files.length === 0 ? (
            <div className="m-3 rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
              Working tree clean.
            </div>
          ) : (
            <ul className="border-b border-border">
              {repository.files.map((file) => (
                <FileRow
                  key={`${file.path}:${file.indexStatus}:${file.worktreeStatus}`}
                  file={file}
                  repository={repository}
                  environmentId={status?.environmentId ?? ""}
                  selected={selectedFiles.has(file.path)}
                  busy={mutationsBlocked}
                  onSelectedChange={(selected) => setSelectedFiles((current) => {
                    const next = new Set(current);
                    if (selected) next.add(file.path); else next.delete(file.path);
                    return next;
                  })}
                  onDiff={(staged) => void loadDiff(file.path, staged)}
                  onStage={() => void runMutation(() => rpc.call("stage_files", {
                    threadId,
                    repositoryPath: repository.relativePath,
                    paths: [file.path],
                  }))}
                  onUnstage={() => void runMutation(() => rpc.call("unstage_files", {
                    threadId,
                    repositoryPath: repository.relativePath,
                    paths: [file.path],
                  }))}
                />
              ))}
            </ul>
          )}

          {diffTarget === null ? null : (
            <section className="border-b border-border">
              <div className="flex items-center justify-between gap-2 px-3 py-2">
                <p className="min-w-0 truncate text-xs font-medium">
                  {diffTarget.staged ? "Staged" : "Working"}: {diffTarget.path}
                </p>
                <Button size="sm" variant="ghost" onClick={() => {
                  setDiffTarget(null);
                  setDiff(null);
                }}>
                  Close
                </Button>
              </div>
              {diff === null ? (
                <div className="px-3 pb-3 text-xs text-muted-foreground">Loading diff…</div>
              ) : diff.patch === "" ? (
                <div className="px-3 pb-3 text-xs text-muted-foreground">No textual diff available.</div>
              ) : (
                <>
                  {diff.truncated ? (
                    <div className="bg-secondary px-3 py-1 text-[11px] text-secondary-foreground">
                      Diff truncated at 1 MiB.
                    </div>
                  ) : null}
                  <Diff patch={diff.patch} path={diffTarget.path} view="unified" />
                </>
              )}
            </section>
          )}

          <section className="space-y-2 px-3 py-3">
            <label className="block text-xs font-medium" htmlFor="multi-repo-commit-message">
              Commit staged changes
            </label>
            <textarea
              id="multi-repo-commit-message"
              value={commitMessage}
              onChange={(event) => setCommitMessage(event.target.value)}
              rows={3}
              maxLength={5_000}
              placeholder="Commit message"
              className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                disabled={mutationsBlocked || repository.detached}
                onClick={() => {
                  if (!window.confirm(`Push ${repository.name}?`)) return;
                  void runMutation(() => rpc.call("push", {
                    threadId,
                    repositoryPath: repository.relativePath,
                  }));
                }}
              >
                <Icon name="Sent" /> Push
              </Button>
              <Button
                disabled={mutationsBlocked || repository.detached || commitMessage.trim() === ""}
                onClick={() => void runMutation(async () => {
                  const result = await rpc.call("commit", {
                    threadId,
                    repositoryPath: repository.relativePath,
                    message: commitMessage.trim(),
                  });
                  setCommitMessage("");
                  return result;
                })}
              >
                <Icon name="Check" /> Commit
              </Button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "workspace-project-menu",
    mount: () => {
      const releaseStylesheet = mountLazyPluginStylesheet();
      const releaseProjectMenu = mountWorkspaceProjectMenu();
      return () => {
        releaseProjectMenu();
        releaseStylesheet();
      };
    },
  });
  app.slots.experimental_appOverlay({
    id: "workspace-sidebar-controller",
    component: WorkspaceSidebarController,
  });
  app.slots.threadPanelAction({
    id: "source-control",
    title: "Source Control",
    icon: "GitBranch",
    layout: "flush",
    component: SourceControlPanel,
    run: ({ openPanel }) => { openPanel({ title: "Source Control" }); },
  });
});
