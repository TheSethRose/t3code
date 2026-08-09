// @effect-diagnostics nodeBuiltinImport:off
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import * as NodeOS from "node:os";

import { describe, expect, it } from "@effect/vitest";

import { parseCursorAppSession, readCursorAppSession, readCursorUsage } from "./usageCursor.ts";

function jwt(accountId = "user_test", expiresAt = 2_000_000_000): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: `auth0|${accountId}`, exp: expiresAt }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

function event(id: number) {
  return {
    timestamp: String(1_722_000_000_000 + id),
    model: "gpt-5",
    tokenUsage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheWriteTokens: 3,
      cacheReadTokens: 7,
      totalCents: 25,
    },
    owningUser: "user_test",
    id,
  };
}

describe("Cursor app auth", () => {
  it("derives the dashboard cookie and account identity from the app JWT", () => {
    const token = jwt();
    expect(parseCursorAppSession(token, 1_900_000_000)).toEqual({
      accountId: "user_test",
      cookieHeader: `WorkosCursorSessionToken=user_test%3A%3A${token}`,
    });
  });

  it("reads the Cursor app state database without modifying it", () => {
    const directory = mkdtempSync(`${NodeOS.tmpdir()}/t3-cursor-usage-`);
    const dbPath = `${directory}/state.vscdb`;
    try {
      const database = new DatabaseSync(dbPath);
      database.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
      database
        .prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)")
        .run("cursorAuth/accessToken", jwt());
      database.close();

      expect(readCursorAppSession(dbPath)?.accountId).toBe("user_test");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("readCursorUsage", () => {
  it("treats Cursor's empty success object as zero usage", async () => {
    const records = await readCursorUsage({
      startDateMs: 1,
      endDateMs: 2,
      fetchPage: async () => ({}),
    });

    expect(records).toEqual([]);
  });

  it("reconciles exact page-boundary overlap and maps provider-reported cost", async () => {
    const first = event(1);
    const boundary = event(2);
    const last = event(3);
    const records = await readCursorUsage({
      startDateMs: 1,
      endDateMs: 2,
      pageSize: 2,
      fetchPage: async ({ page }) => {
        if (page === 1) return { totalUsageEventsCount: 3, usageEventsDisplay: [first, boundary] };
        if (page === 2) return { totalUsageEventsCount: 3, usageEventsDisplay: [boundary, last] };
        return { totalUsageEventsCount: 3, usageEventsDisplay: [] };
      },
    });

    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({
      provider: "cursor",
      model: "gpt-5",
      totals: {
        uncachedInputTokens: 10,
        cachedInputTokens: 7,
        cacheCreationTokens: 3,
        outputTokens: 5,
        reasoningTokens: 0,
      },
      reportedCostUsd: 0.25,
    });
  });

  it("fails rather than returning a capped partial history", async () => {
    await expect(
      readCursorUsage({
        startDateMs: 1,
        endDateMs: 2,
        pageSize: 1,
        maxPages: 1,
        fetchPage: async () => ({ totalUsageEventsCount: 2, usageEventsDisplay: [event(1)] }),
      }),
    ).rejects.toThrow("safety limit");
  });

  it("skips malformed events without discarding valid history", async () => {
    const records = await readCursorUsage({
      startDateMs: 1,
      endDateMs: 2,
      fetchPage: async () => ({
        totalUsageEventsCount: 2,
        usageEventsDisplay: [event(1), "malformed"],
      }),
    });

    expect(records).toHaveLength(1);
  });
});
