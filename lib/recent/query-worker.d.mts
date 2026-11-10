export interface LatestResult {
  rows: { threadId: string; lastMessageAt: number }[];
  nextCursor: { threadId: string; lastMessageAt: number } | null;
  queryMs: number;
}
export function queryLatest(db: unknown, limit?: number, budgetMs?: number, options?: {
  search?: string;
  before?: { threadId: string; lastMessageAt: number };
  threadIds?: string[];
}): LatestResult;
