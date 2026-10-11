import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const fileChangeSchema = z.object({
  path: z.string(), originalPath: z.string().nullable(),
  indexStatus: z.string().length(1), worktreeStatus: z.string().length(1),
  staged: z.boolean(), unstaged: z.boolean(), untracked: z.boolean(),
  conflicted: z.boolean(),
}).strict();

export const repositoryUnavailableReasonSchema = z.enum([
  "missing", "not_repository", "outside_workspace", "unavailable",
]);

export const repositoryStatusSchema = z.object({
  projectId: z.string().nullable(), relativePath: z.string(), name: z.string(),
  available: z.boolean(),
  unavailableReason: repositoryUnavailableReasonSchema.nullable(),
  error: z.string().nullable(), branch: z.string().nullable(),
  detached: z.boolean(), head: z.string().nullable(), upstream: z.string().nullable(),
  ahead: z.number().int().nonnegative(), behind: z.number().int().nonnegative(),
  files: z.array(fileChangeSchema),
}).strict();

export const legacyWorktreeMemberSchema = z.object({
  worktreePath: z.string().min(1), taskBranch: z.string().min(1),
  materializationStatus: z.string().min(1), mergeStatus: z.string().min(1),
  removalStatus: z.string().min(1),
}).strict();

export const legacyWorktreeSetSchema = z.object({
  id: z.string().min(1), hostId: z.string().min(1),
  lifecycleStatus: z.string().min(1), members: z.array(legacyWorktreeMemberSchema),
}).strict();

export const workspaceStatusSchema = z.object({
  environmentId: z.string(), repositories: z.array(repositoryStatusSchema),
  legacyWorktreeSets: z.array(legacyWorktreeSetSchema),
}).strict();

export const diffResultSchema = z.object({
  patch: z.string(), truncated: z.boolean(),
}).strict();

export const mutationResultSchema = z.object({ message: z.string() }).strict();

export const workspaceChildSchema = z.object({
  projectId: z.string(), name: z.string().nullable(), relativePath: z.string(),
  position: z.number().int().nonnegative(), available: z.boolean(),
}).strict();

export const workspaceConfigSchema = z.object({
  rootProjectId: z.string(), enabled: z.boolean(), children: z.array(workspaceChildSchema),
}).strict();

export const workspaceFolderSchema = z.object({
  name: z.string(), relativePath: z.string(), hasChildren: z.boolean(),
  isGitRepository: z.boolean(), connected: z.boolean(),
}).strict();

export const workspaceFolderBrowserSchema = z.object({
  projectId: z.string(), currentPath: z.string(), parentPath: z.string().nullable(),
  folders: z.array(workspaceFolderSchema),
}).strict();

export const workspaceLinkSchema = z.object({
  parentProjectId: z.string(), childProjectId: z.string(), relativePath: z.string(),
  position: z.number().int().nonnegative(),
}).strict();

const workspaceTargetSchema = z.object({ workspaceRoot: z.string().min(1) }).strict();
const repositoryTargetSchema = workspaceTargetSchema.extend({
  repositoryPath: z.string().min(1),
}).strict();
const fileTargetSchema = repositoryTargetSchema.extend({
  filePath: z.string().min(1),
}).strict();

export const hostContract = defineRpcContract({
  resolve_child_directory: {
    input: z.object({ rootPath: z.string().min(1), relativePath: z.string().min(1) }).strict(),
    output: z.object({ absolutePath: z.string().nullable(), name: z.string().nullable() }).strict(),
  },
  list_child_directories: {
    input: z.object({ rootPath: z.string().min(1), relativePath: z.string().min(1) }).strict(),
    output: z.object({
      currentPath: z.string(), parentPath: z.string().nullable(),
      folders: z.array(z.object({
        name: z.string(), relativePath: z.string(), hasChildren: z.boolean(),
        isGitRepository: z.boolean(),
      }).strict()),
    }).strict(),
  },
  relative_child_path: {
    input: z.object({ rootPath: z.string().min(1), childPath: z.string().min(1) }).strict(),
    output: z.object({ relativePath: z.string().nullable() }).strict(),
  },
  scan_selected: {
    input: workspaceTargetSchema.extend({
      repositoryPaths: z.array(z.string().min(1)).min(1).max(100),
    }).strict(),
    output: z.object({ repositories: z.array(repositoryStatusSchema) }).strict(),
  },
  diff: { input: fileTargetSchema.extend({ staged: z.boolean() }).strict(), output: diffResultSchema },
  stage: {
    input: repositoryTargetSchema.extend({ paths: z.array(z.string().min(1)).min(1).max(500) }).strict(),
    output: mutationResultSchema,
  },
  unstage: {
    input: repositoryTargetSchema.extend({ paths: z.array(z.string().min(1)).min(1).max(500) }).strict(),
    output: mutationResultSchema,
  },
  commit: {
    input: repositoryTargetSchema.extend({ message: z.string().trim().min(1).max(5_000) }).strict(),
    output: mutationResultSchema,
  },
  push: { input: repositoryTargetSchema, output: mutationResultSchema },
  create_branch: {
    input: repositoryTargetSchema.extend({ branch: z.string().trim().min(1).max(255) }).strict(),
    output: mutationResultSchema,
  },
});

const threadTargetSchema = z.object({ threadId: z.string().min(1) }).strict();
const threadRepositoryTargetSchema = threadTargetSchema.extend({
  repositoryPath: z.string().min(1),
}).strict();
const threadFileTargetSchema = threadRepositoryTargetSchema.extend({
  filePath: z.string().min(1),
}).strict();

export const rpcContract = defineRpcContract({
  workspace_relations: {
    input: z.null(), output: z.object({ links: z.array(workspaceLinkSchema) }).strict(),
  },
  workspace_config: {
    input: z.object({ projectId: z.string().min(1) }).strict(), output: workspaceConfigSchema,
  },
  workspace_folder_browser: {
    input: z.object({
      projectId: z.string().min(1), relativePath: z.string().min(1).default("."),
    }).strict(),
    output: workspaceFolderBrowserSchema,
  },
  workspace_link_project: {
    input: z.object({
      parentProjectId: z.string().min(1), childProjectId: z.string().min(1),
      relativePath: z.string().min(1),
    }).strict(), output: workspaceConfigSchema,
  },
  workspace_add_folder: {
    input: z.object({ parentProjectId: z.string().min(1), relativePath: z.string().min(1) }).strict(),
    output: workspaceConfigSchema,
  },
  workspace_add_folders: {
    input: z.object({
      parentProjectId: z.string().min(1),
      relativePaths: z.array(z.string().min(1)).min(1).max(50),
    }).strict(), output: workspaceConfigSchema,
  },
  workspace_update_folders: {
    input: z.object({
      parentProjectId: z.string().min(1), relativePaths: z.array(z.string().min(1)).max(50),
    }).strict(), output: workspaceConfigSchema,
  },
  workspace_link_existing_project: {
    input: z.object({
      parentProjectId: z.string().min(1), childProjectId: z.string().min(1),
    }).strict(), output: workspaceConfigSchema,
  },
  workspace_unlink_project: {
    input: z.object({
      parentProjectId: z.string().min(1), childProjectId: z.string().min(1),
    }).strict(), output: workspaceConfigSchema,
  },
  workspace_status: { input: threadTargetSchema, output: workspaceStatusSchema },
  file_diff: {
    input: threadFileTargetSchema.extend({ staged: z.boolean() }).strict(), output: diffResultSchema,
  },
  stage_files: {
    input: threadRepositoryTargetSchema.extend({ paths: z.array(z.string().min(1)).min(1).max(500) }).strict(),
    output: mutationResultSchema,
  },
  unstage_files: {
    input: threadRepositoryTargetSchema.extend({ paths: z.array(z.string().min(1)).min(1).max(500) }).strict(),
    output: mutationResultSchema,
  },
  commit: {
    input: threadRepositoryTargetSchema.extend({ message: z.string().trim().min(1).max(5_000) }).strict(),
    output: mutationResultSchema,
  },
  push: { input: threadRepositoryTargetSchema, output: mutationResultSchema },
  create_branch: {
    input: threadRepositoryTargetSchema.extend({ branch: z.string().trim().min(1).max(255) }).strict(),
    output: mutationResultSchema,
  },
});

export type FileChange = z.infer<typeof fileChangeSchema>;
export type RepositoryUnavailableReason = z.infer<typeof repositoryUnavailableReasonSchema>;
export type RepositoryStatus = z.infer<typeof repositoryStatusSchema>;
export type LegacyWorktreeMember = z.infer<typeof legacyWorktreeMemberSchema>;
export type LegacyWorktreeSet = z.infer<typeof legacyWorktreeSetSchema>;
export type WorkspaceStatus = z.infer<typeof workspaceStatusSchema>;
export type WorkspaceChild = z.infer<typeof workspaceChildSchema>;
export type WorkspaceConfig = z.infer<typeof workspaceConfigSchema>;
export type WorkspaceFolder = z.infer<typeof workspaceFolderSchema>;
export type WorkspaceFolderBrowser = z.infer<typeof workspaceFolderBrowserSchema>;
export type WorkspaceLink = z.infer<typeof workspaceLinkSchema>;
export type DiffResult = z.infer<typeof diffResultSchema>;
