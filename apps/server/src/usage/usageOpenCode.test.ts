import type { OpencodeClient, SessionMessage } from "@opencode-ai/sdk/v2";
import { describe, expect, it } from "@effect/vitest";

import { openCodeMessageToUsageRecord, readOpenCodeUsage } from "./usageOpenCode.ts";

function assistant(id: string): Extract<SessionMessage, { type: "assistant" }> {
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

  it("keeps token usage from a free model at provider-reported zero cost", () => {
    const message = assistant("msg_free");
    message.model = { providerID: "opencode", id: "deepseek-v4-flash-free" };
    message.cost = 0;

    expect(openCodeMessageToUsageRecord("session_1", message)).toMatchObject({
      model: "opencode/deepseek-v4-flash-free",
      reportedCostUsd: 0,
      totals: { uncachedInputTokens: 1, outputTokens: 2 },
    });
  });

  it("accepts both session envelopes and reads legacy-compatible messages", async () => {
    const listCalls: Array<Record<string, unknown>> = [];
    const messageCalls: Array<Record<string, unknown>> = [];
    const client = {
      v2: {
        session: {
          list: async (parameters: Record<string, unknown>) => {
            listCalls.push(parameters);
            const session = {
              id: parameters.cursor ? "session_2" : "session_1",
              projectID: "project_1",
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: 1, updated: 124 },
              title: "Session",
            };
            return parameters.cursor
              ? { data: { items: [session], cursor: { next: null } } }
              : { data: { data: [session], cursor: { next: "next-page" } } };
          },
        },
      },
      session: {
        messages: async (parameters: Record<string, unknown>) => {
          messageCalls.push(parameters);
          const message = assistant(parameters.sessionID === "session_1" ? "msg_1" : "msg_2");
          return {
            data: [
              {
                info: {
                  id: message.id,
                  sessionID: parameters.sessionID,
                  role: "assistant",
                  time: message.time,
                  parentID: "msg_user",
                  modelID: message.model.id,
                  providerID: message.model.providerID,
                  mode: "build",
                  agent: message.agent,
                  path: { cwd: "/tmp", root: "/tmp" },
                  cost: message.cost,
                  tokens: message.tokens,
                },
                parts: [],
              },
            ],
          };
        },
      },
    } as unknown as OpencodeClient;

    const records = await readOpenCodeUsage(client, 123);
    expect(records.map((record) => record.dedupeKey)).toEqual(["opencode:msg_1", "opencode:msg_2"]);
    expect(listCalls).toEqual([
      { limit: 200, order: "desc", roots: true, start: 123 },
      { cursor: "next-page" },
    ]);
    expect(messageCalls).toEqual([{ sessionID: "session_1" }, { sessionID: "session_2" }]);
  });

  it("stops before out-of-window sessions when OpenCode ignores start", async () => {
    let listCalls = 0;
    const session = (id: string, updated: number) => ({
      id,
      projectID: "project_1",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated },
      title: "Session",
    });
    const client = {
      v2: {
        session: {
          list: async () => {
            listCalls += 1;
            return {
              data: {
                data: [session("current", 200), session("old", 99)],
                cursor: { next: "must-not-be-read" },
              },
            };
          },
        },
      },
      session: {
        messages: async ({ sessionID }: { sessionID: string }) => ({
          data: [
            {
              info: {
                id: `msg_${sessionID}`,
                sessionID,
                role: "assistant",
                time: { created: 200, completed: 201 },
                parentID: "msg_user",
                modelID: "deepseek-v4-flash-free",
                providerID: "opencode",
                mode: "build",
                agent: "build",
                path: { cwd: "/tmp", root: "/tmp" },
                cost: 0,
                tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
              },
              parts: [],
            },
          ],
        }),
      },
    } as unknown as OpencodeClient;

    const records = await readOpenCodeUsage(client, 100);
    expect(listCalls).toBe(1);
    expect(records.map((record) => record.sessionId)).toEqual(["current"]);
  });
});
