/**
 * UsageService - scans provider transcripts and returns priced daily usage.
 *
 * The scan reads the provider CLIs' own session files rather than T3 Code's
 * orchestration projections, so usage covers turns driven outside T3 Code too.
 * This is the approach `ccusage` takes.
 *
 * Transcripts are append-only, so parsed records are memoised per file by
 * `(size, mtime)`. A cold 30-day scan of ~1.4 GB lands around 2-3 seconds; warm
 * scans only reparse files that changed.
 *
 * @module UsageService
 */
import { createHash } from "node:crypto";
import * as NodeOS from "node:os";

import {
  OpenCodeSettings,
  USAGE_CONTRACT_VERSION,
  type UsageProviderKind,
  type UsageSource,
  type UsageSummary,
  type UsageSummaryInput,
  UsageReadError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { ServerConfig } from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { OpenCodeRuntime } from "../provider/opencodeRuntime.ts";
import { readCursorAppSession, readCursorUsage, resolveCursorStateDbPath } from "./usageCursor.ts";
import { readOpenCodeUsage } from "./usageOpenCode.ts";
import { UsageAggregator } from "./usageAggregation.ts";
import { parseRateTable, type RateTable } from "./usagePricing.ts";
import {
  listTranscriptFiles,
  readDirectoryVolumeId,
  readTranscriptRecords,
} from "./usageTranscriptReader.ts";
import {
  decodeScanCache,
  dedupeWithinFile,
  encodeScanCache,
  pruneScanCache,
  type ScanCache,
} from "./usageScanCache.ts";
import type { UsageRecord } from "./usageTranscripts.ts";

const LITELLM_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** Rates move rarely; a day-old table keeps the page working offline. */
const RATES_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Files are filtered by mtime before opening. The slack covers a session whose
 * last write lands just before local midnight on the window's first day.
 */
const MTIME_SLACK_MS = 36 * 60 * 60 * 1000;

/** Longest window the UI offers, plus slack. Older entries are pruned. */
const CACHE_RETENTION_DAYS = 90;
const CURSOR_USAGE_URL = "https://cursor.com/api/dashboard/get-filtered-usage-events";

const opaqueSourceId = (value: string): string => createHash("sha256").update(value).digest("hex");

function canonicalServerUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return value.trim();
  }
}

function resolveOpenCodeDataPath(
  environment: NodeJS.ProcessEnv,
  join: (...parts: string[]) => string,
): string {
  if (environment.XDG_DATA_HOME?.trim()) {
    return join(environment.XDG_DATA_HOME, "opencode");
  }
  if (process.platform === "win32" && environment.LOCALAPPDATA?.trim()) {
    return join(environment.LOCALAPPDATA, "opencode");
  }
  return join(environment.HOME?.trim() || NodeOS.homedir(), ".local/share/opencode");
}

function localDayStartMs(day: string, timeZone: string): number | null {
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return null;
  const value = DateTime.makeZoned(
    { year, month, day: date },
    { timeZone, adjustForTimeZone: true, disambiguation: "compatible" },
  );
  return Option.isSome(value) ? DateTime.toEpochMillis(value.value) : null;
}

/** On-disk shape of the rate snapshot. */
const RatesCacheFile = Schema.Struct({
  fetchedAtMs: Schema.Number,
  document: Schema.Unknown,
});
const decodeRatesCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RatesCacheFile as unknown as Schema.Codec<typeof RatesCacheFile.Type>),
);
const encodeRatesCache = Schema.encodeEffect(
  Schema.fromJsonString(RatesCacheFile as unknown as Schema.Codec<typeof RatesCacheFile.Type>),
);

/** The scan cache is narrowed by hand in `usageScanCache`, so JSON is enough here. */
const ScanCacheJson = Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>);
const decodeScanCacheFile = Schema.decodeUnknownEffect(ScanCacheJson);
const encodeScanCacheFile = Schema.encodeEffect(ScanCacheJson);

export class UsageService extends Context.Service<
  UsageService,
  {
    readonly readSummary: (input: UsageSummaryInput) => Effect.Effect<UsageSummary, UsageReadError>;
  }
>()("t3/usage/UsageService") {}

/** Empty summary, for suites that only need the RPC surface to resolve. */
export const layerTest = Layer.succeed(
  UsageService,
  UsageService.of({
    readSummary: (input) =>
      Effect.succeed({
        contractVersion: USAGE_CONTRACT_VERSION,
        readAt: "1970-01-01T00:00:00.000Z",
        timeZone: input.timeZone,
        sinceDay: input.sinceDay,
        untilDay: input.untilDay,
        buckets: [],
        sources: [],
        pricing: {
          status: "unavailable",
          source: LITELLM_RATES_URL,
          fetchedAt: null,
          knownModels: 0,
        },
        scanDurationMs: 0,
      }),
  }),
);

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const openCodeRuntime = yield* OpenCodeRuntime;
  const effectContext = yield* Effect.context<never>();

  const fileCache: ScanCache = new Map();
  let cacheDirty = false;

  const ratesCachePath = path.join(config.stateDir, "usage-model-rates.json");
  const scanCachePath = path.join(config.stateDir, "usage-scan-cache.json");
  let rates: RateTable = new Map();
  let ratesFetchedAtMs: number | null = null;
  let ratesStatus: UsageSummary["pricing"]["status"] = "unavailable";

  /**
   * Loads the LiteLLM rate table, preferring a fresh copy and falling back to
   * the on-disk snapshot. With neither, every model reports as unpriced rather
   * than the page failing.
   */
  const ensureRates = Effect.fn("UsageService.ensureRates")(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (ratesFetchedAtMs !== null && now - ratesFetchedAtMs < RATES_TTL_MS) return;

    if (ratesFetchedAtMs === null) {
      const fromDisk = yield* fileSystem.readFileString(ratesCachePath).pipe(
        Effect.flatMap((raw) => decodeRatesCache(raw)),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (fromDisk !== null) {
        const parsed = parseRateTable(fromDisk.document);
        if (parsed.size > 0) {
          rates = parsed;
          ratesFetchedAtMs = fromDisk.fetchedAtMs;
          ratesStatus = "cached";
          if (now - fromDisk.fetchedAtMs < RATES_TTL_MS) return;
        }
      }
    }

    const fetched = yield* httpClient.get(LITELLM_RATES_URL).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout(10_000),
      Effect.catchCause(() => Effect.succeed(null)),
    );
    if (fetched === null) {
      // The refresh failed; whatever we are serving is now past its TTL and
      // must not keep claiming to be fresh.
      if (rates.size > 0) ratesStatus = "cached";
      return;
    }

    const parsed = parseRateTable(fetched);
    if (parsed.size === 0) return;

    rates = parsed;
    ratesFetchedAtMs = now;
    ratesStatus = "fresh";

    yield* encodeRatesCache({ fetchedAtMs: now, document: fetched }).pipe(
      Effect.flatMap((serialized) => fileSystem.writeFileString(ratesCachePath, serialized)),
      Effect.catchCause(() => Effect.void),
    );
  });

  /**
   * Claude's config dir is the home itself when overridden, but a default
   * install nests transcripts under `~/.claude/projects`. Probe both.
   */
  const resolveClaudeTranscriptDir = (homePath: string) =>
    Effect.gen(function* () {
      const nested = path.join(homePath, ".claude", "projects");
      const nestedExists = yield* fileSystem
        .exists(nested)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));
      return nestedExists ? nested : path.join(homePath, "projects");
    });

  /** Resolves the transcript directory for each provider. */
  const resolveUsageInputs = Effect.fn("UsageService.resolveUsageInputs")(function* () {
    // A settings failure must surface as an error: swallowing it here would
    // present "zero usage from every provider" as a valid answer.
    const settings = yield* settingsService.getSettings.pipe(
      Effect.catchCause(
        (cause) =>
          new UsageReadError({
            reason: "scanFailed",
            // Bounded description; the squashed failure travels as the cause.
            // Squashed, not the Cause tree: a full tree in a Defect field is
            // the unbounded wire payload the bounded detail exists to avoid.
            detail: "Server settings could not be read.",
            cause: Cause.squash(cause),
          }),
      ),
    );

    const claudeHome = yield* resolveClaudeHomePath(settings.providers.claudeAgent);
    const claudeDir = yield* resolveClaudeTranscriptDir(claudeHome);
    const codexLayout = yield* resolveCodexHomeLayout(settings.providers.codex);

    const openCodeConfigs = [];
    for (const instance of Object.values(deriveProviderInstanceConfigMap(settings))) {
      if (instance.driver !== "opencode") continue;
      const decoded = Schema.decodeUnknownOption(OpenCodeSettings)(instance.config ?? {});
      if (Option.isNone(decoded)) continue;
      const config = decoded.value;
      if (!(instance.enabled ?? config.enabled)) continue;
      openCodeConfigs.push({
        config,
        environment: mergeProviderInstanceEnvironment(instance.environment),
      });
    }

    return {
      dirs: [
        { provider: "claude" as const, dir: claudeDir },
        { provider: "codex" as const, dir: path.join(codexLayout.sharedHomePath, "sessions") },
      ],
      openCodeConfigs,
    };
  });

  /**
   * Loads the persisted scan cache exactly once per process.
   *
   * `Effect.cached` makes concurrent first readers await the same load rather
   * than each seeing a "loaded" flag set before the read finished and cold
   * scanning against an empty cache.
   */
  const ensureScanCacheLoaded = yield* Effect.cached(
    Effect.gen(function* () {
      const document = yield* fileSystem.readFileString(scanCachePath).pipe(
        Effect.flatMap((raw) => decodeScanCacheFile(raw)),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (document === null) return;
      for (const [path, entry] of decodeScanCache(document)) fileCache.set(path, entry);
    }),
  );

  const persistScanCache = Effect.fn("UsageService.persistScanCache")(function* () {
    if (!cacheDirty) return;
    // Cleared only after the write lands, so a failed persist is retried on
    // the next scan instead of leaving disk permanently stale.
    yield* encodeScanCacheFile(encodeScanCache(fileCache)).pipe(
      Effect.flatMap((serialized) => fileSystem.writeFileString(scanCachePath, serialized)),
      Effect.map(() => {
        cacheDirty = false;
      }),
      // A cache we cannot write is a slower next start, not a failed read.
      Effect.catchCause(() => Effect.void),
    );
  });

  /** Parses one transcript, reusing the cached result when it is unchanged. */
  const readFileRecords = (
    filePath: string,
    size: number,
    mtimeMs: number,
    provider: UsageProviderKind,
  ): Effect.Effect<readonly UsageRecord[]> =>
    Effect.gen(function* () {
      const cached = fileCache.get(filePath);
      // Provider is part of the identity: if both providers were ever pointed
      // at one directory, a hit parsed by the other parser must not be reused.
      if (
        cached &&
        cached.size === size &&
        cached.mtimeMs === mtimeMs &&
        cached.provider === provider
      ) {
        return cached.records;
      }

      const parsed = yield* Effect.promise(() => readTranscriptRecords(filePath, provider));
      // A read failure is not an empty transcript: caching it under this
      // (size, mtime) would silently drop the file's usage until it changes.
      if (parsed === null) return [];
      // Stored already de-duplicated within the file, which is 99% of all
      // duplicates. The aggregator still runs the cross-file dedupe pass.
      const records = dedupeWithinFile(parsed);

      fileCache.set(filePath, { size, mtimeMs, provider, records });
      cacheDirty = true;
      return records;
    });

  const readSummary = Effect.fn("UsageService.readSummary")(function* (input: UsageSummaryInput) {
    if (input.sinceDay > input.untilDay) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is after untilDay '${input.untilDay}'`,
      });
    }

    const startedAtMs = yield* Clock.currentTimeMillis;
    yield* ensureRates();
    yield* ensureScanCacheLoaded;

    const hostId = NodeOS.hostname();
    // The home resolvers ask for `Path` themselves; satisfy them from the
    // instance we already hold so `readSummary` stays context-free.
    const { dirs, openCodeConfigs } = yield* resolveUsageInputs().pipe(
      Effect.provideService(Path.Path, path),
    );
    const windowStart = DateTime.make(`${input.sinceDay}T00:00:00Z`);
    if (Option.isNone(windowStart)) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is not a valid date`,
      });
    }
    const windowUntil = DateTime.make(`${input.untilDay}T00:00:00Z`);
    if (Option.isNone(windowUntil)) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `untilDay '${input.untilDay}' is not a valid date`,
      });
    }
    const windowStartMs = DateTime.toEpochMillis(windowStart.value) - MTIME_SLACK_MS;
    const localUntilStartMs = localDayStartMs(input.untilDay, input.timeZone);
    const cursorStartMs =
      localDayStartMs(input.sinceDay, input.timeZone) ?? DateTime.toEpochMillis(windowStart.value);
    const cursorUntilStartMs = localUntilStartMs ?? DateTime.toEpochMillis(windowUntil.value);
    const cursorEndMs =
      localUntilStartMs === null
        ? cursorUntilStartMs + 24 * 60 * 60 * 1000
        : DateTime.toEpochMillis(
            DateTime.add(
              DateTime.makeZonedUnsafe(cursorUntilStartMs, { timeZone: input.timeZone }),
              { days: 1 },
            ),
          );

    const aggregator = new UsageAggregator({
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      rates,
    });

    const sources: UsageSource[] = [];
    const providerBuckets: UsageSummary["buckets"][number][] = [];
    const livePaths = new Set<string>();
    const walkedRoots: string[] = [];

    for (const { provider, dir } of dirs) {
      const volumeId = yield* Effect.promise(() => readDirectoryVolumeId(dir));
      const exists = yield* fileSystem
        .exists(dir)
        .pipe(Effect.catchCause(() => Effect.succeed(false)));

      if (!exists) {
        sources.push({
          fingerprint: {
            hostId,
            provider,
            scope: "localFilesystem",
            sourceId: "",
            resolvedHomePath: dir,
            volumeId,
          },
          status: "missing",
          scannedFiles: 0,
          skippedFiles: 0,
          malformedRecords: 0,
          distinctSessions: 0,
          message: "No transcript directory on this environment.",
        });
        continue;
      }

      walkedRoots.push(dir);
      const files = yield* Effect.promise(() => listTranscriptFiles(dir, windowStartMs));
      let scannedFiles = 0;
      let skippedFiles = 0;
      // Distinct per directory. Buckets carry per-cell session counts, but a
      // session spans days and models, so clients total this figure instead.
      const sessionIds = new Set<string>();

      for (const file of files) {
        livePaths.add(file.path);
        const records = yield* readFileRecords(file.path, file.size, file.mtimeMs, provider);
        if (records.length === 0) {
          skippedFiles += 1;
          continue;
        }
        scannedFiles += 1;
        for (const record of records) {
          // Only sessions that contributed in-window count: the mtime slack
          // admits boundary files whose records fall outside the range.
          if (aggregator.add(record) && record.sessionId.length > 0) {
            sessionIds.add(record.sessionId);
          }
        }
      }

      sources.push({
        fingerprint: {
          hostId,
          provider,
          scope: "localFilesystem",
          sourceId: "",
          resolvedHomePath: dir,
          volumeId,
        },
        status: "ok",
        scannedFiles,
        skippedFiles,
        malformedRecords: 0,
        distinctSessions: sessionIds.size,
        message: null,
      });
    }

    const seenOpenCodeSources = new Set<string>();
    for (const { config: openCodeConfig, environment } of openCodeConfigs) {
      const external = openCodeConfig.serverUrl.trim().length > 0;
      const localPath = resolveOpenCodeDataPath(environment, path.join);
      const canonicalUrl = external ? canonicalServerUrl(openCodeConfig.serverUrl) : null;
      const volumeId = external
        ? ""
        : yield* Effect.promise(() => readDirectoryVolumeId(localPath));
      const sourceId = opaqueSourceId(
        external
          ? `opencode-server:${canonicalUrl}`
          : `opencode-local:${hostId}:${localPath}:${volumeId}`,
      );
      if (seenOpenCodeSources.has(sourceId)) continue;
      seenOpenCodeSources.add(sourceId);

      const fingerprint = {
        hostId,
        provider: "opencode" as const,
        scope: external ? ("remoteServer" as const) : ("localFilesystem" as const),
        sourceId,
        resolvedHomePath: external ? "OpenCode server" : localPath,
        volumeId,
      };
      if (
        !external &&
        !(yield* fileSystem.exists(localPath).pipe(Effect.orElseSucceed(() => false)))
      ) {
        sources.push({
          fingerprint,
          status: "missing",
          scannedFiles: 0,
          skippedFiles: 0,
          malformedRecords: 0,
          distinctSessions: 0,
          message: "No OpenCode history on this environment.",
        });
        continue;
      }

      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const server = yield* openCodeRuntime.connectToOpenCodeServer({
            binaryPath: openCodeConfig.binaryPath,
            serverUrl: openCodeConfig.serverUrl,
            environment,
          });
          const client = openCodeRuntime.createOpenCodeSdkClient({
            baseUrl: server.url,
            directory: config.cwd,
            ...(server.external && openCodeConfig.serverPassword
              ? { serverPassword: openCodeConfig.serverPassword }
              : {}),
          });
          return yield* Effect.tryPromise(() => readOpenCodeUsage(client, windowStartMs));
        }),
      ).pipe(Effect.result);

      if (result._tag === "Failure") {
        sources.push({
          fingerprint,
          status: "failed",
          scannedFiles: 0,
          skippedFiles: 0,
          malformedRecords: 0,
          distinctSessions: 0,
          message: "OpenCode history could not be read.",
        });
        continue;
      }

      const sourceAggregator = new UsageAggregator({
        timeZone: input.timeZone,
        sinceDay: input.sinceDay,
        untilDay: input.untilDay,
        rates,
        sourceId,
      });
      const sessions = new Set<string>();
      for (const record of result.success) {
        if (sourceAggregator.add(record)) sessions.add(record.sessionId);
      }
      providerBuckets.push(...sourceAggregator.finish().buckets);
      sources.push({
        fingerprint,
        status: "ok",
        scannedFiles: 0,
        skippedFiles: 0,
        malformedRecords: 0,
        distinctSessions: sessions.size,
        message: null,
      });
    }

    const cursorDbPath = resolveCursorStateDbPath();
    if (cursorDbPath !== null) {
      const cursorExists = yield* fileSystem
        .exists(cursorDbPath)
        .pipe(Effect.orElseSucceed(() => false));
      const localFingerprint = {
        hostId,
        provider: "cursor" as const,
        scope: "localFilesystem" as const,
        sourceId: "",
        resolvedHomePath: cursorDbPath,
        volumeId: "",
      };
      if (!cursorExists) {
        sources.push({
          fingerprint: localFingerprint,
          status: "missing",
          scannedFiles: 0,
          skippedFiles: 0,
          malformedRecords: 0,
          distinctSessions: 0,
          message: "No signed-in Cursor app state on this environment.",
        });
      } else {
        const cursorSession = yield* Effect.try(() => readCursorAppSession(cursorDbPath)).pipe(
          Effect.result,
        );
        if (cursorSession._tag === "Failure" || cursorSession.success === null) {
          sources.push({
            fingerprint: localFingerprint,
            status: cursorSession._tag === "Failure" ? "failed" : "missing",
            scannedFiles: 0,
            skippedFiles: 0,
            malformedRecords: 0,
            distinctSessions: 0,
            message:
              cursorSession._tag === "Failure"
                ? "Cursor app authentication could not be read."
                : "Cursor app is not signed in.",
          });
        } else {
          const cursorAuth = cursorSession.success;
          const sourceId = opaqueSourceId(`cursor-account:${cursorAuth.accountId}`);
          const fingerprint = {
            ...localFingerprint,
            scope: "remoteAccount" as const,
            sourceId,
            resolvedHomePath: "Cursor account",
          };
          const cursorResult = yield* Effect.tryPromise(() =>
            readCursorUsage({
              startDateMs: cursorStartMs,
              endDateMs: cursorEndMs,
              fetchPage: (body) =>
                Effect.runPromiseWith(effectContext)(
                  HttpClientRequest.post(CURSOR_USAGE_URL).pipe(
                    HttpClientRequest.setHeader("accept", "application/json"),
                    HttpClientRequest.setHeader("cookie", cursorAuth.cookieHeader),
                    HttpClientRequest.setHeader("origin", "https://cursor.com"),
                    HttpClientRequest.bodyJsonUnsafe(body),
                    httpClient.execute,
                    Effect.flatMap(HttpClientResponse.filterStatusOk),
                    Effect.flatMap((response) => response.json),
                    Effect.timeout(30_000),
                  ),
                ),
            }),
          ).pipe(Effect.result);

          if (cursorResult._tag === "Failure") {
            sources.push({
              fingerprint,
              status: "failed",
              scannedFiles: 0,
              skippedFiles: 0,
              malformedRecords: 0,
              distinctSessions: 0,
              message: "Cursor usage history could not be read.",
            });
          } else {
            const sourceAggregator = new UsageAggregator({
              timeZone: input.timeZone,
              sinceDay: input.sinceDay,
              untilDay: input.untilDay,
              rates,
              sourceId,
            });
            for (const record of cursorResult.success) sourceAggregator.add(record);
            providerBuckets.push(...sourceAggregator.finish().buckets);
            sources.push({
              fingerprint,
              status: "ok",
              scannedFiles: 0,
              skippedFiles: 0,
              malformedRecords: 0,
              distinctSessions: 0,
              message: null,
            });
          }
        }
      }
    }

    const pruned = pruneScanCache(fileCache, {
      livePaths,
      walkedRoots,
      windowStartMs,
      retentionCutoffMs: startedAtMs - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    });
    if (pruned > 0) cacheDirty = true;
    yield* persistScanCache();

    const aggregated = aggregator.finish();
    const readAt = yield* DateTime.now;
    const finishedAtMs = yield* Clock.currentTimeMillis;

    return {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: DateTime.formatIso(readAt),
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      buckets: [...aggregated.buckets, ...providerBuckets].sort(
        (a, b) =>
          a.day.localeCompare(b.day) ||
          a.provider.localeCompare(b.provider) ||
          a.model.localeCompare(b.model),
      ),
      sources,
      pricing: {
        status: ratesStatus,
        source: LITELLM_RATES_URL,
        fetchedAt:
          ratesFetchedAtMs === null
            ? null
            : DateTime.formatIso(DateTime.makeUnsafe(ratesFetchedAtMs)),
        knownModels: rates.size,
      },
      scanDurationMs: Math.max(0, finishedAtMs - startedAtMs),
    } satisfies UsageSummary;
  });

  return { readSummary } as const;
});

export const layer = Layer.effect(UsageService, make);
