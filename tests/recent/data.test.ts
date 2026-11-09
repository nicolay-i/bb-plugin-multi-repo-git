import { describe, expect, it } from "vitest";
import { messageTime, topRecent } from "../../lib/recent/data.js";
import { assistant, event, tool, user } from "./fixtures";

describe("Семантика сохранённых сообщений", () => {
  it("учитывает user, completed assistant и дату edit от BB", () => {
    expect(messageTime(user(100))).toBe(100);
    expect(messageTime(assistant(200))).toBe(200);
    expect(messageTime(user(900, 13))).toBe(900);
    expect(messageTime(assistant(950, 14))).toBe(950);
  });
  it.each(["image", "localImage", "localFile"])("учитывает вложение без текста: %s", type => {
    expect(messageTime(user(100, 1, { input: [{ type, path: "synthetic", url: "https://example.invalid/synthetic" }] }))).toBe(100);
  });
  it("исключает пустые, agent-only, системные запросы и повторы", () => {
    expect(messageTime(user(100, 1, { input: [] }))).toBeNull();
    expect(messageTime(user(100, 1, { input: [{ type: "text", text: " \u00a0\u2003 " }] }))).toBeNull();
    expect(messageTime(user(100, 1, { input: [{ type: "localFile", visibility: "agent-only" }] }))).toBeNull();
    expect(messageTime(user(100, 1, { initiator: "system" }))).toBeNull();
    expect(messageTime(user(100, 1, { retryOfRequestId: "synthetic" }))).toBeNull();
  });
  it("не принимает delta, tools, reasoning, lifecycle и provider echo за сообщение", () => {
    expect(messageTime(event("item/agentMessage/delta", { delta: "synthetic" }, 300))).toBeNull();
    expect(messageTime(tool(300))).toBeNull();
    expect(messageTime(event("item/completed", { item: { type: "reasoning", summary: [], content: [] } }, 300))).toBeNull();
    expect(messageTime(event("item/completed", { item: { type: "userMessage", content: [] } }, 300))).toBeNull();
    expect(messageTime(event("system/operation", { operation: "context_clear" }, 300))).toBeNull();
    expect(messageTime(assistant(300, 1, { parentToolCallId: "synthetic-tool" }))).toBeNull();
    expect(messageTime(assistant(300, 1, { text: " " }))).toBeNull();
  });
  it("plan и legacy visible text учитываются, planSteps — нет", () => {
    expect(messageTime(assistant(200, 1, { type: "plan" }))).toBe(200);
    expect(messageTime(event("system/manager/user_message", { text: "legacy" }, 300))).toBe(300);
    expect(messageTime(event("system/manager/user_message", { text: "\u00a0" }, 300))).toBeNull();
    expect(messageTime(event("item/completed", { item: { type: "planSteps", steps: [] } }, 300))).toBeNull();
  });
  it("отказывает при некорректной дате; не подставляет updatedAt", () => {
    expect(() => messageTime(user(NaN))).toThrow("дата");
  });
  it("сортирует глобально и стабильно, limit применяется последним", () => {
    const index = new Map(Array.from({ length: 240 }, (_, i) => [`thr_${String(i).padStart(3, "0")}`, { lastMessageAt: Math.floor(i / 2), lastSeq: 1 }] as const));
    const rows = topRecent(index);
    expect(rows).toHaveLength(50); expect(rows[0]!.threadId).toBe("thr_238");
    expect(rows[1]!.threadId).toBe("thr_239"); expect(rows.at(-1)!.threadId).toBe("thr_191");
  });
});
