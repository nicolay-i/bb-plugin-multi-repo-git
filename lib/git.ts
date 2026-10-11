import { spawn } from "node:child_process";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { availableParallelism, loadavg } from "node:os";
import type {
  FileChange,
  RepositoryStatus,
  RepositoryUnavailableReason,
} from "../contract.js";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_DIFF_BYTES = 1024 * 1024;

export class GitCommandError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(message: string, exitCode: number | null, stderr: string) {
    super(message);
    this.name = "GitCommandError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

interface GitResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

async function runGit(
  cwd: string,
  args: readonly string[],
  options: { allowExitCodes?: readonly number[]; signal?: AbortSignal } = {},
): Promise<GitResult> {
  options.signal?.throwIfAborted();
  const allowExitCodes = options.allowExitCodes ?? [0];
  return await new Promise<GitResult>((resolvePromise, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGTERM");
        fail(new Error("Git output exceeded the 4 MiB safety limit."));
        return;
      }
      target.push(chunk);
    };

    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", fail);
    const abort = () => {
      child.kill("SIGTERM");
      fail(new Error("Git operation was cancelled."));
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    child.on("close", (code) => {
      options.signal?.removeEventListener("abort", abort);
      if (settled) return;
      const result: GitResult = {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode: code ?? -1,
      };
      if (!allowExitCodes.includes(result.exitCode)) {
        const errorText = result.stderr.toString("utf8").trim();
        fail(new GitCommandError(
          errorText || `git ${args[0] ?? "command"} failed with exit code ${String(code)}.`,
          code,
          errorText,
        ));
        return;
      }
      settled = true;
      resolvePromise(result);
    });
  });
}

async function gitText(
  cwd: string,
  args: readonly string[],
  options?: { allowExitCodes?: readonly number[]; signal?: AbortSignal },
): Promise<string> {
  return (await runGit(cwd, args, options)).stdout.toString("utf8").trim();
}

function isInside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (
    !value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value)
  );
}

function validateRelativePath(value: string, label: string): void {
  if (
    value.length === 0 || value.includes("\0") || isAbsolute(value) ||
    value === ".." || value.startsWith(`..${sep}`) ||
    value.startsWith("../") || value.startsWith("..\\")
  ) {
    throw new Error(`${label} must be a workspace-relative path.`);
  }
}

export async function resolveRepository(
  workspaceRoot: string,
  repositoryPath: string,
  signal?: AbortSignal,
): Promise<{ workspace: string; repository: string }> {
  const workspace = await realpath(workspaceRoot);
  validateRelativePath(repositoryPath, "Repository path");
  const candidate = resolve(workspace, repositoryPath);
  if (!isInside(workspace, candidate)) throw new Error("Repository path escapes the workspace.");
  const repository = await realpath(candidate);
  if (!isInside(workspace, repository)) throw new Error("Repository resolves outside the workspace.");
  const topLevel = await realpath(
    await gitText(repository, ["rev-parse", "--show-toplevel"], { signal }),
  );
  if (topLevel !== repository) throw new Error("Selected path is not a Git repository root.");
  return { workspace, repository };
}

function validateFilePaths(repository: string, paths: readonly string[]): void {
  for (const path of paths) {
    validateRelativePath(path, "File path");
    if (!isInside(repository, resolve(repository, path))) {
      throw new Error("File path escapes the repository.");
    }
  }
}

function literalPathspec(path: string): string {
  return `:(literal)${path}`;
}

function isConflict(indexStatus: string, worktreeStatus: string): boolean {
  return new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]).has(
    `${indexStatus}${worktreeStatus}`,
  );
}

export function parsePorcelainV1(buffer: Buffer): FileChange[] {
  const records = buffer.toString("utf8").split("\0");
  const files: FileChange[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const indexStatus = record[0] ?? " ";
    const worktreeStatus = record[1] ?? " ";
    if (indexStatus === "!" && worktreeStatus === "!") continue;
    const path = record.slice(3);
    let originalPath: string | null = null;
    if (["R", "C"].includes(indexStatus) || ["R", "C"].includes(worktreeStatus)) {
      originalPath = records[index + 1] || null;
      index += 1;
    }
    const untracked = indexStatus === "?" && worktreeStatus === "?";
    files.push({
      path, originalPath, indexStatus, worktreeStatus,
      staged: !untracked && indexStatus !== " " && indexStatus !== "!",
      unstaged: untracked || (worktreeStatus !== " " && worktreeStatus !== "!"),
      untracked, conflicted: isConflict(indexStatus, worktreeStatus),
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function optionalGitText(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await runGit(cwd, args, { allowExitCodes: [0, 1, 128], signal });
  if (result.exitCode !== 0) return null;
  const value = result.stdout.toString("utf8").trim();
  return value === "" ? null : value;
}

async function readRepositoryStatus(
  workspace: string,
  repository: string,
  relativePath: string,
  signal?: AbortSignal,
): Promise<RepositoryStatus> {
  const [branch, head, upstream, status] = await Promise.all([
    optionalGitText(repository, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal),
    optionalGitText(repository, ["rev-parse", "--short", "HEAD"], signal),
    optionalGitText(repository, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], signal),
    runGit(repository, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { signal }),
  ]);
  let ahead = 0;
  let behind = 0;
  if (upstream !== null) {
    const counts = await optionalGitText(
      repository, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`], signal,
    );
    const [aheadText, behindText] = counts?.split(/\s+/) ?? [];
    ahead = Number.parseInt(aheadText ?? "0", 10) || 0;
    behind = Number.parseInt(behindText ?? "0", 10) || 0;
  }
  return {
    projectId: null,
    relativePath,
    name: relativePath === "." ? basename(workspace) : basename(repository),
    available: true,
    unavailableReason: null,
    error: null,
    branch,
    detached: branch === null,
    head,
    upstream,
    ahead,
    behind,
    files: parsePorcelainV1(status.stdout),
  };
}

function unavailableRepository(
  workspace: string,
  repositoryPath: string,
  reason: RepositoryUnavailableReason,
  error: string,
): RepositoryStatus {
  return {
    projectId: null,
    relativePath: repositoryPath,
    name: repositoryPath === "." ? basename(workspace) : basename(repositoryPath),
    available: false,
    unavailableReason: reason,
    error,
    branch: null,
    detached: true,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
  };
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function repositoryScanConcurrency(cpuCount: number, load: number): number {
  // ponytail: CPU/load heuristic, up to four Git readers per repository;
  // use measured I/O throughput if this conservative budget proves insufficient.
  return Math.max(1, Math.min(4, Math.floor((cpuCount - load) / 4)));
}

async function scanRepository(
  workspace: string,
  inputPath: string,
  signal?: AbortSignal,
): Promise<RepositoryStatus> {
  const repositoryPath = inputPath.replaceAll("\\", "/");
  try {
    validateRelativePath(repositoryPath, "Repository path");
  } catch (cause) {
    return unavailableRepository(
      workspace, repositoryPath, "outside_workspace", causeMessage(cause),
    );
  }

  const unresolved = resolve(workspace, repositoryPath);
  if (!isInside(workspace, unresolved)) {
    return unavailableRepository(
      workspace, repositoryPath, "outside_workspace", "Repository path escapes the workspace.",
    );
  }

  let candidate: string;
  try {
    candidate = await realpath(unresolved);
  } catch (cause) {
    if (signal?.aborted) throw cause;
    const reason = (cause as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing" as const
      : "unavailable" as const;
    return unavailableRepository(workspace, repositoryPath, reason, causeMessage(cause));
  }
  if (!isInside(workspace, candidate)) {
    return unavailableRepository(
      workspace, repositoryPath, "outside_workspace", "Repository resolves outside the workspace.",
    );
  }

  let topLevel: string;
  try {
    topLevel = await realpath(
      await gitText(candidate, ["rev-parse", "--show-toplevel"], { signal }),
    );
  } catch (cause) {
    if (signal?.aborted) throw cause;
    return unavailableRepository(
      workspace, repositoryPath, "not_repository", causeMessage(cause),
    );
  }
  if (topLevel !== candidate || !isInside(workspace, topLevel)) {
    return unavailableRepository(
      workspace,
      repositoryPath,
      !isInside(workspace, topLevel) ? "outside_workspace" : "not_repository",
      !isInside(workspace, topLevel)
        ? "Repository resolves outside the workspace."
        : "Selected path is not a Git repository root.",
    );
  }
  try {
    return await readRepositoryStatus(workspace, candidate, repositoryPath, signal);
  } catch (cause) {
    if (signal?.aborted) throw cause;
    return unavailableRepository(
      workspace, repositoryPath, "unavailable", causeMessage(cause),
    );
  }
}

export async function scanSelectedRepositories(
  workspaceRoot: string,
  repositoryPaths: readonly string[],
  signal?: AbortSignal,
): Promise<RepositoryStatus[]> {
  signal?.throwIfAborted();
  const workspace = await realpath(workspaceRoot);
  const concurrency = Math.min(repositoryPaths.length,
    repositoryScanConcurrency(availableParallelism(), loadavg()[0]));
  const repositories = new Array<RepositoryStatus>(repositoryPaths.length);
  let next = 0;
  // ponytail: budget is per scan; share a host-wide budget if overlapping scans become frequent.
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < repositoryPaths.length) {
      signal?.throwIfAborted();
      const index = next++;
      repositories[index] = await scanRepository(workspace, repositoryPaths[index]!, signal);
    }
  }));
  return repositories;
}

export async function getFileDiff(
  workspaceRoot: string,
  repositoryPath: string,
  filePath: string,
  staged: boolean,
  signal?: AbortSignal,
): Promise<{ patch: string; truncated: boolean }> {
  const { repository } = await resolveRepository(workspaceRoot, repositoryPath, signal);
  validateFilePaths(repository, [filePath]);
  const pathspec = literalPathspec(filePath);
  let result: GitResult;
  if (!staged) {
    const status = await runGit(repository, ["status", "--porcelain=v1", "-z", "--", pathspec], { signal });
    const change = parsePorcelainV1(status.stdout).find((entry) => entry.path === filePath);
    result = change?.untracked === true
      ? await runGit(repository, ["diff", "--no-index", "--no-color", "--", "/dev/null", filePath], { allowExitCodes: [0, 1], signal })
      : await runGit(repository, ["diff", "--no-ext-diff", "--no-color", "--find-renames", "--", pathspec], { signal });
  } else {
    result = await runGit(repository, ["diff", "--cached", "--no-ext-diff", "--no-color", "--find-renames", "--", pathspec], { signal });
  }
  const truncated = result.stdout.length > MAX_DIFF_BYTES;
  return { patch: result.stdout.subarray(0, MAX_DIFF_BYTES).toString("utf8"), truncated };
}

export async function stageFiles(
  workspaceRoot: string, repositoryPath: string, paths: readonly string[], signal?: AbortSignal,
): Promise<string> {
  const { repository } = await resolveRepository(workspaceRoot, repositoryPath, signal);
  validateFilePaths(repository, paths);
  await runGit(repository, ["add", "--", ...paths.map(literalPathspec)], { signal });
  return `Staged ${paths.length} file${paths.length === 1 ? "" : "s"}.`;
}

export async function unstageFiles(
  workspaceRoot: string, repositoryPath: string, paths: readonly string[], signal?: AbortSignal,
): Promise<string> {
  const { repository } = await resolveRepository(workspaceRoot, repositoryPath, signal);
  validateFilePaths(repository, paths);
  await runGit(repository, ["restore", "--staged", "--", ...paths.map(literalPathspec)], { signal });
  return `Unstaged ${paths.length} file${paths.length === 1 ? "" : "s"}.`;
}

export async function commitRepository(
  workspaceRoot: string, repositoryPath: string, message: string, signal?: AbortSignal,
): Promise<string> {
  const { repository } = await resolveRepository(workspaceRoot, repositoryPath, signal);
  const branch = await optionalGitText(repository, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal);
  if (branch === null) throw new Error("Cannot commit in detached HEAD. Create or switch to a branch first.");
  const output = await gitText(repository, ["commit", "-m", message.trim()], { signal });
  return output || `Committed on ${branch}.`;
}

export async function pushRepository(
  workspaceRoot: string, repositoryPath: string, signal?: AbortSignal,
): Promise<string> {
  const { repository } = await resolveRepository(workspaceRoot, repositoryPath, signal);
  const branch = await optionalGitText(repository, ["symbolic-ref", "--quiet", "--short", "HEAD"], signal);
  if (branch === null) throw new Error("Cannot push from detached HEAD.");
  const upstream = await optionalGitText(repository, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], signal);
  const args = upstream === null ? ["push", "--set-upstream", "origin", branch] : ["push"];
  const result = await runGit(repository, args, { signal });
  const text = `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`.trim();
  return text || `Pushed ${branch}.`;
}

export async function createBranch(
  workspaceRoot: string, repositoryPath: string, branch: string, signal?: AbortSignal,
): Promise<string> {
  const { repository } = await resolveRepository(workspaceRoot, repositoryPath, signal);
  await runGit(repository, ["check-ref-format", "--branch", branch.trim()], { signal });
  await runGit(repository, ["switch", "-c", branch.trim()], { signal });
  return `Created and switched to ${branch.trim()}.`;
}
