import { z } from "zod";

export const latestSchema = z.object({
  rows: z.array(z.object({
    threadId: z.string().min(1).max(200),
    lastMessageAt: z.number().finite().int(),
  }).strict()).max(50),
  queryMs: z.number().finite().nonnegative(),
}).strict();
