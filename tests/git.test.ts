import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitRepository,
  createBranch,
  getFileDiff,
  parsePorcelainV1,
  pushRepository,
  resolveRepository,
  scanSelectedRepositories,
  stageFiles,
  unstageFiles,
} from "../lib/git.js";

const temporaryDirectories: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function initializeRepository(path: string, name: string): Promise<void> {
  await mkdir(path, { recursive: true });
  git(path, "init", "-b", "main");
  git(path, "config", "user.email", "test@example.com");
  git(path, "config", "user.name", "Plugin Test");
  await writeFile(join(path, "README.md"), `# ${name}\n`);
  git(path, "add", "README.md");
  git(path, "commit", "-m", "initial");
}

async function createRepository(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `${name}-`));
  temporaryDirectories.push(root);
  await initializeRepository(root, name);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("parsePorcelainV1", () => {
  it("parses staged, unstaged, untracked and renamed records", () => {
    const input = Buffer.from(
      "M  staged.ts\0 M working.ts\0?? new.ts\0R  renamed.ts\0old.ts\0",
    );
    expect(parsePorcelainV1(input)).toEqual([
      expect.objectContaining({ path: "new.ts", untracked: true, unstaged: true }),
      expect.objectContaining({ path: "renamed.ts", originalPath: "old.ts", staged: true }),
      expect.objectContaining({ path: "staged.ts", staged: true, unstaged: false }),
      expect.objectContaining({ path: "working.ts", staged: false, unstaged: true }),
    ]);
  });
});

describe("environment-local repository scanning", () => {
  it("returns every explicit member and never discovers an undeclared repository", async () => {
    const root = await createRepository("explicit-root");
    await initializeRepository(join(root, "packages", "child"), "child");
    await initializeRepository(join(root, "packages", "undeclared"), "undeclared");
    await mkdir(join(root, "packages", "ordinary"), { recursive: true });

    const repositories = await scanSelectedRepositories(root, [
      ".", "packages/child", "packages/missing", "packages/ordinary",
    ]);
    expect(repositories.map((repository) => repository.relativePath)).toEqual([
      ".", "packages/child", "packages/missing", "packages/ordinary",
    ]);
    expect(repositories).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: "packages/undeclared" }),
    ]));
    expect(repositories[0]).toMatchObject({
      available: true, unavailableReason: null,
      branch: "main", detached: false, head: expect.any(String),
      upstream: null, ahead: 0, behind: 0,
    });
    expect(repositories[1]).toMatchObject({ available: true, unavailableReason: null });
    expect(repositories[2]).toMatchObject({ available: false, unavailableReason: "missing" });
    expect(repositories[3]).toMatchObject({
      available: false,
      unavailableReason: "not_repository",
    });
  }, 30_000);

  it("reports path escapes as unavailable without touching outside repositories", async () => {
    const root = await createRepository("confined-root");
    const outside = await createRepository("confined-outside");
    const before = git(outside, "status", "--porcelain=v1");
    const [escaped] = await scanSelectedRepositories(root, ["../outside"]);
    expect(escaped).toMatchObject({
      relativePath: "../outside",
      available: false,
      unavailableReason: "outside_workspace",
    });
    expect(git(outside, "status", "--porcelain=v1")).toBe(before);
  });
});

describe("repository-local Git operations", () => {
  it("stages, diffs, and unstages only the selected child repository", async () => {
    const root = await createRepository("isolated-root");
    const child = join(root, "packages", "child");
    await initializeRepository(child, "child");
    await writeFile(join(root, "README.md"), "# root changed\n");
    await writeFile(join(child, "README.md"), "# child changed\n");

    await stageFiles(root, "packages/child", ["README.md"]);
    const statuses = await scanSelectedRepositories(root, [".", "packages/child"]);
    expect(statuses[0]?.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "README.md", unstaged: true, staged: false }),
    ]));
    expect(statuses[1]?.files).toEqual([
      expect.objectContaining({ path: "README.md", staged: true, unstaged: false }),
    ]);
    expect((await getFileDiff(root, "packages/child", "README.md", true)).patch)
      .toContain("child changed");
    await unstageFiles(root, "packages/child", ["README.md"]);
    const [childStatus] = await scanSelectedRepositories(root, ["packages/child"]);
    expect(childStatus?.files).toEqual([
      expect.objectContaining({ path: "README.md", staged: false, unstaged: true }),
    ]);
  }, 30_000);

  it("treats file names as literal Git pathspecs", async () => {
    const root = await createRepository("literal-paths");
    await writeFile(join(root, "[note].txt"), "literal file\n");
    await writeFile(join(root, "n.txt"), "must stay untracked\n");
    expect((await getFileDiff(root, ".", "[note].txt", false)).patch)
      .toContain("literal file");
    await stageFiles(root, ".", ["[note].txt"]);
    const [repository] = await scanSelectedRepositories(root, ["."]);
    expect(repository?.files).toEqual([
      expect.objectContaining({ path: "[note].txt", staged: true }),
      expect.objectContaining({ path: "n.txt", untracked: true }),
    ]);
  });

  it("blocks detached commit and push until a branch is created", async () => {
    const root = await createRepository("branch-commit-push");
    const remote = await mkdtemp(join(tmpdir(), "branch-commit-push-remote-"));
    temporaryDirectories.push(remote);
    git(remote, "init", "--bare");
    git(root, "remote", "add", "origin", remote);
    git(root, "checkout", "--detach");
    expect((await scanSelectedRepositories(root, ["."]))[0]).toMatchObject({
      available: true, branch: null, detached: true, head: expect.any(String), upstream: null,
    });
    await writeFile(join(root, "README.md"), "# staged content\n");
    await stageFiles(root, ".", ["README.md"]);

    await expect(commitRepository(root, ".", "blocked")).rejects.toThrow("detached HEAD");
    await expect(pushRepository(root, ".")).rejects.toThrow("detached HEAD");
    await expect(createBranch(root, ".", "feature/safe-flow")).resolves.toContain("feature/safe-flow");
    await expect(commitRepository(root, ".", "staged only")).resolves.toContain("staged only");
    await expect(pushRepository(root, ".")).resolves.toContain("feature/safe-flow");
    expect(git(remote, "rev-parse", "refs/heads/feature/safe-flow"))
      .toBe(git(root, "rev-parse", "HEAD"));
    expect((await scanSelectedRepositories(root, ["."]))[0]).toMatchObject({
      branch: "feature/safe-flow", detached: false,
      upstream: "origin/feature/safe-flow", ahead: 0, behind: 0, files: [],
    });
  }, 30_000);

  it("rejects mutation targets outside the active workspace", async () => {
    const root = await createRepository("safe-root");
    await expect(resolveRepository(root, "../outside")).rejects.toThrow("workspace-relative");
    await expect(resolveRepository(root, "nested/../../outside")).rejects.toThrow("escapes the workspace");
  });
});
