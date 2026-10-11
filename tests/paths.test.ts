import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { listChildDirectories } from "../lib/paths.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("project folder browser", () => {
  it("lists real child folders and identifies repository roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-folders-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "backend"));
    await writeFile(join(root, "backend", ".git"), "gitdir: elsewhere\n");
    await mkdir(join(root, "packages", "shared"), { recursive: true });
    await mkdir(join(root, ".git"));

    await expect(listChildDirectories(root, ".")).resolves.toEqual({
      currentPath: ".",
      parentPath: null,
      folders: [
        {
          name: "backend",
          relativePath: "backend",
          hasChildren: false,
          isGitRepository: true,
        },
        {
          name: "packages",
          relativePath: "packages",
          hasChildren: true,
          isGitRepository: false,
        },
      ],
    });
    await expect(listChildDirectories(root, "packages")).resolves.toEqual({
      currentPath: "packages",
      parentPath: ".",
      folders: [
        {
          name: "shared",
          relativePath: "packages/shared",
          hasChildren: false,
          isGitRepository: false,
        },
      ],
    });
  });

  it("rejects browsing outside the project", async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-folders-safe-"));
    temporaryDirectories.push(root);
    await expect(listChildDirectories(root, "../outside")).rejects.toThrow(
      "stay inside",
    );
  });
});
