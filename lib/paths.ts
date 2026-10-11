import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readdir, realpath, stat } from "node:fs/promises";

export interface ChildDirectoryEntry {
  name: string;
  relativePath: string;
  hasChildren: boolean;
  isGitRepository: boolean;
}

export interface ChildDirectoryListing {
  currentPath: string;
  parentPath: string | null;
  folders: ChildDirectoryEntry[];
}

function isInside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return (
    value === "" ||
    (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value))
  );
}

function validBrowsePath(value: string): boolean {
  return !(
    value.length === 0 ||
    value.includes("\0") ||
    isAbsolute(value) ||
    value === ".." ||
    value.startsWith(`..${sep}`) ||
    value.startsWith("../") ||
    value.startsWith("..\\")
  );
}

async function directoryMarkerExists(path: string): Promise<boolean> {
  try {
    const marker = await stat(path);
    return marker.isDirectory() || marker.isFile();
  } catch {
    return false;
  }
}

async function hasChildDirectories(path: string): Promise<boolean> {
  try {
    return (await readdir(path, { withFileTypes: true })).some(
      (entry) => !entry.name.startsWith(".") && entry.isDirectory(),
    );
  } catch {
    return false;
  }
}

export async function listChildDirectories(
  rootPath: string,
  relativePath: string,
): Promise<ChildDirectoryListing> {
  if (!validBrowsePath(relativePath)) {
    throw new Error("Folder path must stay inside the project.");
  }
  const root = await realpath(rootPath);
  const candidate = await realpath(resolve(root, relativePath));
  if (!isInside(root, candidate)) {
    throw new Error("Folder path escapes the project.");
  }
  const candidateStat = await stat(candidate);
  if (!candidateStat.isDirectory()) {
    throw new Error("Folder path is not a directory.");
  }

  const currentRelative = relative(root, candidate);
  const currentPath = currentRelative === "" ? "." : currentRelative.split(sep).join("/");
  const entries = (await readdir(candidate, { withFileTypes: true }))
    .filter((entry) => !entry.name.startsWith(".") && entry.isDirectory())
    .sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
    )
    .slice(0, 500);
  const folders = await Promise.all(
    entries.map(async (entry): Promise<ChildDirectoryEntry> => {
      const absolutePath = join(candidate, entry.name);
      const childRelative = relative(root, absolutePath).split(sep).join("/");
      return {
        name: entry.name,
        relativePath: childRelative,
        hasChildren: await hasChildDirectories(absolutePath),
        isGitRepository: await directoryMarkerExists(join(absolutePath, ".git")),
      };
    }),
  );
  folders.sort(
    (left, right) =>
      Number(right.isGitRepository) - Number(left.isGitRepository) ||
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );

  const parentDirectory = dirname(candidate);
  const parentRelative = relative(root, parentDirectory);
  return {
    currentPath,
    parentPath:
      currentPath === "."
        ? null
        : parentRelative === ""
          ? "."
          : parentRelative.split(sep).join("/"),
    folders,
  };
}

export async function resolveChildDirectory(
  rootPath: string,
  relativePath: string,
): Promise<{ absolutePath: string | null; name: string | null }> {
  if (
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    isAbsolute(relativePath) ||
    relativePath === "." ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\")
  ) {
    return { absolutePath: null, name: null };
  }
  try {
    const root = await realpath(rootPath);
    const candidate = await realpath(resolve(root, relativePath));
    const candidateStat = await stat(candidate);
    if (!candidateStat.isDirectory() || root === candidate || !isInside(root, candidate)) {
      return { absolutePath: null, name: null };
    }
    return { absolutePath: candidate, name: basename(candidate) };
  } catch {
    return { absolutePath: null, name: null };
  }
}

export async function relativeChildPath(
  rootPath: string,
  childPath: string,
): Promise<string | null> {
  const [root, child] = await Promise.all([realpath(rootPath), realpath(childPath)]);
  const [rootStat, childStat] = await Promise.all([stat(root), stat(child)]);
  if (!rootStat.isDirectory() || !childStat.isDirectory()) return null;
  if (root === child || !isInside(root, child)) return null;
  return relative(root, child).split(sep).join("/");
}
