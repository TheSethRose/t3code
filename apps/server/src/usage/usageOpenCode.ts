import type {
  OpencodeClient,
  SessionMessage,
  V2SessionMessagesResponse,
  V2SessionsResponse,
} from "@opencode-ai/sdk/v2";

import { totalTokens, type UsageRecord } from "./usageTranscripts.ts";

const PAGE_SIZE = 1000;
const MAX_PAGES = 10_000;
const token = (value: number): number =>
  Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;

export function openCodeMessageToUsageRecord(
  sessionId: string,
  message: SessionMessage,
): UsageRecord | null {
  if (message.type !== "assistant" || message.time.completed === undefined || !message.tokens) {
    return null;
  }
  if (!Number.isFinite(message.time.created) || message.time.created <= 0) return null;

  const totals = {
    uncachedInputTokens: token(message.tokens.input),
    cachedInputTokens: token(message.tokens.cache.read),
    cacheCreationTokens: token(message.tokens.cache.write),
    outputTokens: token(message.tokens.output),
    reasoningTokens: Math.min(token(message.tokens.output), token(message.tokens.reasoning)),
  };
  if (totalTokens(totals) === 0) return null;

  return {
    provider: "opencode",
    timestampMs: message.time.created,
    model: `${message.model.providerID}/${message.model.id}`,
    sessionId,
    totals,
    reportedCostUsd:
      typeof message.cost === "number" && Number.isFinite(message.cost) && message.cost >= 0
        ? message.cost
        : null,
    dedupeKey: `opencode:${message.id}`,
  };
}

export async function readOpenCodeUsage(
  client: OpencodeClient,
  sinceMs: number,
): Promise<readonly UsageRecord[]> {
  const sessions = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data: V2SessionsResponse | undefined = (
      await client.v2.session.list(
        cursor ? { cursor } : { limit: PAGE_SIZE, order: "desc", roots: true, start: sinceMs },
      )
    ).data;
    if (!data) throw new Error("OpenCode session history returned no data.");
    sessions.push(...data.items);
    if (!data.cursor.next) break;
    if (data.cursor.next === cursor)
      throw new Error("OpenCode session pagination repeated a cursor.");
    cursor = data.cursor.next;
    if (page === MAX_PAGES - 1)
      throw new Error("OpenCode session history exceeded the page limit.");
  }

  const records: UsageRecord[] = [];
  for (const session of sessions) {
    cursor = undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const data: V2SessionMessagesResponse | undefined = (
        await client.v2.session.messages(
          cursor
            ? { sessionID: session.id, cursor }
            : { sessionID: session.id, limit: PAGE_SIZE, order: "asc" },
        )
      ).data;
      if (!data) throw new Error(`OpenCode session '${session.id}' returned no messages.`);
      for (const message of data.items) {
        const record = openCodeMessageToUsageRecord(session.id, message);
        if (record) records.push(record);
      }
      if (!data.cursor.next) break;
      if (data.cursor.next === cursor) {
        throw new Error(`OpenCode session '${session.id}' repeated a message cursor.`);
      }
      cursor = data.cursor.next;
      if (page === MAX_PAGES - 1) {
        throw new Error(`OpenCode session '${session.id}' exceeded the page limit.`);
      }
    }
  }
  return records;
}
