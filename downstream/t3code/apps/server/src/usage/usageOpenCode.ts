import type {
  OpencodeClient,
  SessionMessagesResponse,
  SessionMessage,
  V2SessionsResponse,
} from "@opencode-ai/sdk/v2";

import { totalTokens, type UsageRecord } from "./usageTranscripts.ts";

const PAGE_SIZE = 200;
const MAX_PAGES = 10_000;
const token = (value: number): number =>
  Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;

function pageItems<T>(
  value: unknown,
  label: string,
): {
  readonly items: readonly T[];
  readonly next: string | undefined;
} {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} returned no data.`);
  }
  const page = value as {
    readonly items?: unknown;
    readonly data?: unknown;
    readonly cursor?: { readonly next?: unknown };
  };
  const items = Array.isArray(page.items) ? page.items : page.data;
  if (!Array.isArray(items) || typeof page.cursor !== "object" || page.cursor === null) {
    throw new Error(`${label} returned an unsupported page.`);
  }
  if (
    page.cursor.next !== undefined &&
    page.cursor.next !== null &&
    typeof page.cursor.next !== "string"
  ) {
    throw new Error(`${label} returned an invalid cursor.`);
  }
  return { items: items as readonly T[], next: page.cursor.next ?? undefined };
}

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

function legacyMessageToUsageRecord(
  sessionId: string,
  message: SessionMessagesResponse[number]["info"],
): UsageRecord | null {
  if (message.role !== "assistant" || message.time.completed === undefined) return null;

  return openCodeMessageToUsageRecord(sessionId, {
    id: message.id,
    type: "assistant",
    time: message.time,
    agent: message.agent,
    model: { providerID: message.providerID, id: message.modelID },
    content: [],
    cost: message.cost,
    tokens: message.tokens,
  });
}

function sessionToUsageRecord(session: V2SessionsResponse["items"][number]): UsageRecord | null {
  const totals = {
    uncachedInputTokens: token(session.tokens.input),
    cachedInputTokens: token(session.tokens.cache.read),
    cacheCreationTokens: token(session.tokens.cache.write),
    outputTokens: token(session.tokens.output),
    reasoningTokens: Math.min(token(session.tokens.output), token(session.tokens.reasoning)),
  };
  if (totalTokens(totals) === 0) return null;

  return {
    provider: "opencode",
    timestampMs: session.time.updated,
    model: session.model ? `${session.model.providerID}/${session.model.id}` : "unknown",
    sessionId: session.id,
    totals,
    reportedCostUsd: Number.isFinite(session.cost) && session.cost >= 0 ? session.cost : null,
    dedupeKey: `opencode-session:${session.id}`,
  };
}

export async function readOpenCodeUsage(
  client: OpencodeClient,
  sinceMs: number,
): Promise<readonly UsageRecord[]> {
  const sessions: V2SessionsResponse["items"] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = (
      await client.v2.session.list(
        cursor ? { cursor } : { limit: PAGE_SIZE, order: "desc", roots: true, start: sinceMs },
      )
    ).data;
    const data = pageItems<V2SessionsResponse["items"][number]>(
      response,
      "OpenCode session history",
    );
    sessions.push(...data.items.filter((session) => session.time.updated >= sinceMs));
    // OpenCode 1.18 ignores the pinned SDK's `start` query. Pages are newest
    // first, so the first older session is the end of the requested window.
    if (data.items.some((session) => session.time.updated < sinceMs)) break;
    if (!data.next) break;
    if (data.next === cursor) throw new Error("OpenCode session pagination repeated a cursor.");
    cursor = data.next;
    if (page === MAX_PAGES - 1)
      throw new Error("OpenCode session history exceeded the page limit.");
  }

  const records: UsageRecord[] = [];
  for (const session of sessions) {
    // OpenCode's own stats command reads the complete legacy message projection.
    // The v2 projection rejects many valid pre-v2 sessions in current stores.
    try {
      const messages = (await client.session.messages({ sessionID: session.id })).data;
      if (!messages) throw new Error(`OpenCode session '${session.id}' returned no messages.`);
      for (const message of messages) {
        const record = legacyMessageToUsageRecord(session.id, message.info);
        if (record) records.push(record);
      }
    } catch {
      const record = sessionToUsageRecord(session);
      if (record) records.push(record);
    }
  }
  return records;
}
