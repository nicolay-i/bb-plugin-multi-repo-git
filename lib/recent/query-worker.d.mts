export interface LatestResult {
  rows: { threadId: string; lastMessageAt: number }[];
  queryMs: number;
}
export function queryLatest(db: unknown, limit?: number, budgetMs?: number): LatestResult;
