import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract.js";
import {
  listChildDirectories,
  relativeChildPath,
  resolveChildDirectory,
} from "./lib/paths.js";
import {
  commitRepository,
  createBranch,
  getFileDiff,
  pushRepository,
  scanSelectedRepositories,
  stageFiles,
  unstageFiles,
} from "./lib/git.js";

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    list_child_directories: async ({ rootPath, relativePath }) =>
      listChildDirectories(rootPath, relativePath),
    resolve_child_directory: async ({ rootPath, relativePath }) =>
      resolveChildDirectory(rootPath, relativePath),
    relative_child_path: async ({ rootPath, childPath }) => ({
      relativePath: await relativeChildPath(rootPath, childPath),
    }),
    scan_selected: async ({ workspaceRoot, repositoryPaths }, context) => ({
      repositories: await scanSelectedRepositories(
        workspaceRoot,
        repositoryPaths,
        context.signal,
      ),
    }),
    diff: ({ workspaceRoot, repositoryPath, filePath, staged }, context) =>
      getFileDiff(workspaceRoot, repositoryPath, filePath, staged, context.signal),
    stage: async ({ workspaceRoot, repositoryPath, paths }, context) => ({
      message: await stageFiles(
        workspaceRoot,
        repositoryPath,
        paths,
        context.signal,
      ),
    }),
    unstage: async ({ workspaceRoot, repositoryPath, paths }, context) => ({
      message: await unstageFiles(
        workspaceRoot,
        repositoryPath,
        paths,
        context.signal,
      ),
    }),
    commit: async ({ workspaceRoot, repositoryPath, message }, context) => ({
      message: await commitRepository(
        workspaceRoot,
        repositoryPath,
        message,
        context.signal,
      ),
    }),
    push: async ({ workspaceRoot, repositoryPath }, context) => ({
      message: await pushRepository(
        workspaceRoot,
        repositoryPath,
        context.signal,
      ),
    }),
    create_branch: async ({ workspaceRoot, repositoryPath, branch }, context) => ({
      message: await createBranch(
        workspaceRoot,
        repositoryPath,
        branch,
        context.signal,
      ),
    }),
  },
});
