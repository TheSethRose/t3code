import type { OpencodeClient, SessionMessage } from "@opencode-ai/sdk/v2";
import { describe, expect, it } from "@effect/vitest";

import { openCodeMessageToUsageRecord, readOpenCodeUsage } from "./usageOpenCode.ts";

function assistant(id: string): SessionMessage {
  return {
    id,
    type: "assistant",
    time: { created: 1_722_000_000_000, completed: 1_722_000_001_000 },
    agent: "build",
    model: { providerID: "openai", id: "gpt-5" },
    content: [],
    cost: 0.1,
    tokens: { input: 1, output: 2, reasoning: 1, cache: { read: 3, write: 4 } },
  };
}

describe("openCodeMessageToUsageRecord", () => {
  it("maps one completed assistant response without changing token categories", () => {
    const message: SessionMessage = {
      id: "msg_1",
      type: "assistant",
      time: { created: 1_722_000_000_000, completed: 1_722_000_001_000 },
      agent: "build",
      model: { providerID: "anthropic", id: "claude-sonnet-4-5" },
      content: [],
      cost: 0.42,
      tokens: {
        input: 10,
        output: 20,
        reasoning: 7,
        cache: { read: 30, write: 40 },
      },
    };

    expect(openCodeMessageToUsageRecord("session_1", message)).toEqual({
      provider: "opencode",
      timestampMs: 1_722_000_000_000,
      model: "anthropic/claude-sonnet-4-5",
      sessionId: "session_1",
      totals: {
        uncachedInputTokens: 10,
        cachedInputTokens: 30,
        cacheCreationTokens: 40,
        outputTokens: 20,
        reasoningTokens: 7,
      },
      reportedCostUsd: 0.42,
      dedupeKey: "opencode:msg_1",
    });
  });

  it("ignores incomplete assistant responses", () => {
    const message: SessionMessage = {
      id: "msg_2",
      type: "assistant",
      time: { created: 1_722_000_000_000 },
      agent: "build",
      model: { providerID: "openai", id: "gpt-5" },
      content: [],
    };

    expect(openCodeMessageToUsageRecord("session_1", message)).toBeNull();
  });

  it("follows the SDK cursors for sessions and messages", async () => {
    const messageCalls: Array<Record<string, unknown>> = [];
    const client = {
      v2: {
        session: {
          list: async () => ({
            data: {
              items: [
                {
                  id: "session_1",
                  projectID: "project_1",
                  cost: 0,
                  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                  time: { created: 1, updated: 2 },
                  title: "Session",
                },
              ],
              cursor: {},
            },
          }),
          messages: async (parameters: Record<string, unknown>) => {
            messageCalls.push(parameters);
            return parameters.cursor
              ? { data: { items: [assistant("msg_2")], cursor: {} } }
              : { data: { items: [assistant("msg_1")], cursor: { next: "next-page" } } };
          },
        },
      },
    } as unknown as OpencodeClient;

    const records = await readOpenCodeUsage(client, 123);
    expect(records.map((record) => record.dedupeKey)).toEqual(["opencode:msg_1", "opencode:msg_2"]);
    expect(messageCalls).toEqual([
      { sessionID: "session_1", limit: 1000, order: "asc" },
      { sessionID: "session_1", cursor: "next-page" },
    ]);
  });
});
