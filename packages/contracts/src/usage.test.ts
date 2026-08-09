import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { UsageBucket, UsageSourceFingerprint } from "./usage.ts";

describe("Usage contract compatibility", () => {
  it("defaults source identity on older filesystem payloads", () => {
    const fingerprint = Schema.decodeUnknownSync(UsageSourceFingerprint)({
      hostId: "mac",
      provider: "claude",
      resolvedHomePath: "/Users/test/.claude",
      volumeId: "1:2",
    });
    expect(fingerprint.scope).toBe("localFilesystem");
    expect(fingerprint.sourceId).toBe("");
  });

  it("accepts OpenCode and Cursor buckets", () => {
    for (const provider of ["opencode", "cursor"] as const) {
      expect(
        Schema.decodeUnknownSync(UsageBucket)({
          day: "2026-08-08",
          provider,
          model: "provider/model",
          totals: {
            uncachedInputTokens: 1,
            cachedInputTokens: 2,
            cacheCreationTokens: 3,
            outputTokens: 4,
            reasoningTokens: 0,
          },
          costUsd: 0.1,
          cacheSavingsUsd: 0,
          costSource: "providerReported",
          records: 1,
          unpricedRecords: 0,
          sessions: 1,
        }).sourceId,
      ).toBe("");
    }
  });
});
