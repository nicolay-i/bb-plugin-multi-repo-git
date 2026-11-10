import { z } from "zod";

export const cursorSchema = z.object({
  threadId: z.string().min(1).max(200),
  lastMessageAt: z.number().safe(),
}).strict();
export type RecentCursor = z.infer<typeof cursorSchema>;
export const pageInputSchema = z.object({
  search: z.string().max(500).trim().default(""),
  before: cursorSchema.optional(),
  threadIds: z.array(z.string().min(1).max(200)).max(50).optional(),
}).strict();
export type PageInput = z.infer<typeof pageInputSchema>;
export const latestSchema = z.object({
  rows: z.array(cursorSchema).max(50),
  nextCursor: cursorSchema.nullable(),
  queryMs: z.number().finite().nonnegative(),
}).strict();
