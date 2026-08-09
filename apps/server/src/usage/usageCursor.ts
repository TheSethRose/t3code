// @effect-diagnostics globalDate:off
import { createHash } from "node:crypto";
import * as NodeOS from "node:os";
import { DatabaseSync } from "node:sqlite";

import * as Schema from "effect/Schema";

import { totalTokens, type UsageRecord } from "./usageTranscripts.ts";

const CURSOR_AUTH_KEY = "cursorAuth/accessToken";
const CURSOR_PAGE_SIZE = 1000;
const CURSOR_MAX_PAGES = 200;

const CursorEvent = Schema.Struct({
  timestamp: Schema.optionalKey(Schema.Unknown),
  model: Schema.optionalKey(Schema.Unknown),
  tokenUsage: Schema.optionalKey(
    Schema.Struct({
      inputTokens: Schema.optionalKey(Schema.Unknown),
      outputTokens: Schema.optionalKey(Schema.Unknown),
      cacheWriteTokens: Schema.optionalKey(Schema.Unknown),
      cacheReadTokens: Schema.optionalKey(Schema.Unknown),
      totalCents: Schema.optionalKey(Schema.Unknown),
    }),
  ),
});
const CursorPage = Schema.Struct({
  totalUsageEventsCount: Schema.optionalKey(Schema.Unknown),
  usageEventsDisplay: Schema.Array(Schema.Unknown),
});

export interface CursorAppSession {
  readonly accountId: string;
  readonly cookieHeader: string;
}

function number(value: unknown): number | null {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeInt(value: unknown): number {
  const parsed = number(value);
  return parsed === null || parsed < 0 ? 0 : Math.trunc(parsed);
}

export function resolveCursorStateDbPath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const home = environment.HOME?.trim() || NodeOS.homedir();
  if (platform === "darwin") {
    return `${home}/Library/Application Support/Cursor/User/globalStorage/state.vscdb`;
  }
  if (platform === "linux") {
    const configHome = environment.XDG_CONFIG_HOME?.trim() || `${home}/.config`;
    return `${configHome}/Cursor/User/globalStorage/state.vscdb`;
  }
  return null;
}

export function parseCursorAppSession(
  accessToken: string,
  nowSeconds: number = Date.now() / 1000,
): CursorAppSession {
  const parts = accessToken.trim().split(".");
  if (parts.length < 2 || !parts[1]) throw new Error("Cursor app access token is not a JWT.");

  const payload = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({ sub: Schema.String, exp: Schema.Number }) as unknown as Schema.Codec<{
        readonly sub: string;
        readonly exp: number;
      }>,
    ),
  )(Buffer.from(parts[1], "base64url").toString("utf8"));
  const accountId = payload.sub.split("|").filter(Boolean).at(-1);
  if (!accountId || !/^[a-zA-Z0-9._-]+$/.test(accountId)) {
    throw new Error("Cursor app access token has an invalid account ID.");
  }
  if (payload.exp <= nowSeconds + 60) throw new Error("Cursor app access token has expired.");

  return {
    accountId,
    cookieHeader: `WorkosCursorSessionToken=${accountId}%3A%3A${accessToken.trim()}`,
  };
}

export function readCursorAppSession(dbPath: string): CursorAppSession | null {
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout = 250");
    const row = database
      .prepare("SELECT value FROM ItemTable WHERE key = ? LIMIT 1")
      .get(CURSOR_AUTH_KEY) as { readonly value?: unknown } | undefined;
    const value = row?.value;
    const token =
      typeof value === "string"
        ? value
        : value instanceof Uint8Array
          ? Buffer.from(value).toString("utf8")
          : null;
    return token?.trim() ? parseCursorAppSession(token) : null;
  } finally {
    database.close();
  }
}

function boundaryOverlap(previous: readonly unknown[], current: readonly unknown[]): number {
  const previousJson = previous.map((event) => JSON.stringify(event));
  const currentJson = current.map((event) => JSON.stringify(event));
  for (let count = Math.min(previous.length, current.length); count > 0; count -= 1) {
    if (
      previousJson
        .slice(previousJson.length - count)
        .every((value, index) => value === currentJson[index])
    ) {
      return count;
    }
  }
  return 0;
}

function cursorEventToUsageRecord(raw: unknown, occurrence: number): UsageRecord | null {
  const event = Schema.decodeUnknownSync(CursorEvent)(raw);
  const timestampMs = number(event.timestamp);
  if (timestampMs === null || timestampMs <= 0 || !event.tokenUsage) return null;

  const totals = {
    uncachedInputTokens: nonNegativeInt(event.tokenUsage.inputTokens),
    cachedInputTokens: nonNegativeInt(event.tokenUsage.cacheReadTokens),
    cacheCreationTokens: nonNegativeInt(event.tokenUsage.cacheWriteTokens),
    outputTokens: nonNegativeInt(event.tokenUsage.outputTokens),
    reasoningTokens: 0,
  };
  if (totalTokens(totals) === 0) return null;

  const cents = number(event.tokenUsage.totalCents);
  const payloadHash = createHash("sha256").update(JSON.stringify(raw)).digest("hex");
  return {
    provider: "cursor",
    timestampMs,
    model: typeof event.model === "string" && event.model.trim() ? event.model : "unknown",
    sessionId: "",
    totals,
    reportedCostUsd: cents !== null && cents >= 0 ? cents / 100 : null,
    dedupeKey: `cursor:${payloadHash}:${occurrence}`,
  };
}

export async function readCursorUsage(input: {
  readonly startDateMs: number;
  readonly endDateMs: number;
  readonly fetchPage: (body: {
    readonly page: number;
    readonly pageSize: number;
    readonly startDate: string;
    readonly endDate: string;
  }) => Promise<unknown>;
  readonly pageSize?: number;
  readonly maxPages?: number;
}): Promise<readonly UsageRecord[]> {
  const pageSize = input.pageSize ?? CURSOR_PAGE_SIZE;
  const maxPages = input.maxPages ?? CURSOR_MAX_PAGES;
  const pages: unknown[][] = [];
  let expectedTotal: number | null = null;
  let completed = false;

  for (let page = 1; page <= maxPages; page += 1) {
    const raw = await input.fetchPage({
      page,
      pageSize,
      startDate: String(input.startDateMs),
      endDate: String(input.endDateMs),
    });
    const decoded =
      typeof raw === "object" &&
      raw !== null &&
      !Array.isArray(raw) &&
      Object.keys(raw).length === 0
        ? { usageEventsDisplay: [] }
        : Schema.decodeUnknownSync(CursorPage)(raw);
    const reported = number(decoded.totalUsageEventsCount);
    if (reported !== null) {
      const total = Math.trunc(reported);
      if (
        !Number.isInteger(reported) ||
        total < 0 ||
        (expectedTotal !== null && total !== expectedTotal)
      ) {
        throw new Error("Cursor usage pagination reported an inconsistent total.");
      }
      expectedTotal = total;
    }
    if (decoded.usageEventsDisplay.length === 0) {
      completed = true;
      break;
    }
    pages.push([...decoded.usageEventsDisplay]);
    if (decoded.usageEventsDisplay.length < pageSize) {
      completed = true;
      break;
    }
  }

  const rawEvents = pages.flat();
  if (!completed) throw new Error("Cursor usage pagination reached its safety limit.");
  let events = rawEvents;
  if (expectedTotal !== null) {
    if (rawEvents.length < expectedTotal) throw new Error("Cursor usage history ended early.");
    let removals = rawEvents.length - expectedTotal;
    const reconciled = [...(pages[0] ?? [])];
    for (let index = 1; index < pages.length; index += 1) {
      const overlap = boundaryOverlap(pages[index - 1] ?? [], pages[index] ?? []);
      const remove = Math.min(overlap, removals);
      reconciled.push(...(pages[index] ?? []).slice(remove));
      removals -= remove;
    }
    if (removals !== 0 || reconciled.length !== expectedTotal) {
      throw new Error("Cursor usage pagination could not reconcile duplicate boundaries.");
    }
    events = reconciled;
  }

  const occurrences = new Map<string, number>();
  return events.flatMap((event) => {
    const key = JSON.stringify(event);
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    try {
      const record = cursorEventToUsageRecord(event, occurrence);
      return record ? [record] : [];
    } catch {
      return [];
    }
  });
}
