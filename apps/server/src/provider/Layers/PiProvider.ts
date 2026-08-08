import {
  ProviderDriverKind,
  type ModelCapabilities,
  type PiSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { makePiRpcClient, resolvePiLaunchArgs } from "../pi/PiRpcClient.ts";

const DRIVER = ProviderDriverKind.make("pi");
const VERSION_TIMEOUT_MS = 4_000;
const DISCOVERY_TIMEOUT_MS = 20_000;
const PRESENTATION = {
  displayName: "Pi",
  badgeLabel: "Downstream",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

interface PiModel {
  readonly provider?: unknown;
  readonly id?: unknown;
  readonly name?: unknown;
  readonly reasoning?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asPiModels(value: unknown): ReadonlyArray<PiModel> {
  return isRecord(value) && Array.isArray(value.models) ? value.models.filter(isRecord) : [];
}

function modelSlug(model: PiModel): string | undefined {
  const provider = typeof model.provider === "string" ? model.provider.trim() : "";
  const id = typeof model.id === "string" ? model.id.trim() : "";
  return provider && id ? `${provider}/${id}` : undefined;
}

function titleizeThinkingLevel(level: string): string {
  return level === "xhigh" ? "Extra high" : `${level[0]?.toUpperCase() ?? ""}${level.slice(1)}`;
}

function capabilitiesForThinkingLevels(
  levels: ReadonlyArray<string>,
  currentLevel: string | undefined,
): ModelCapabilities {
  if (levels.length <= 1 && levels[0] === "off") return EMPTY_CAPABILITIES;
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: "thinkingLevel",
        label: "Thinking",
        type: "select",
        options: levels.map((level) => ({
          id: level,
          label: titleizeThinkingLevel(level),
          ...(level === currentLevel ? { isDefault: true } : {}),
        })),
        ...(currentLevel ? { currentValue: currentLevel } : {}),
      },
    ],
  });
}

const discoverPiModels = (settings: PiSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const rpc = yield* makePiRpcClient({
      binaryPath: settings.binaryPath,
      args: [
        ...resolvePiLaunchArgs(settings.launchArgs),
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--offline",
      ],
      environment,
    });
    const available = yield* rpc.request({ type: "get_available_models" });
    const state = yield* rpc.request({ type: "get_state" });
    const stateModel =
      isRecord(state) && isRecord(state.model) ? modelSlug(state.model) : undefined;
    const stateThinking =
      isRecord(state) && typeof state.thinkingLevel === "string" ? state.thinkingLevel : undefined;
    const seen = new Set<string>();

    return yield* Effect.forEach(asPiModels(available), (model) =>
      Effect.gen(function* () {
        const slug = modelSlug(model);
        if (!slug || seen.has(slug)) return undefined;
        seen.add(slug);
        const [provider, ...idParts] = slug.split("/");
        const modelId = idParts.join("/");
        const levels = yield* Effect.gen(function* () {
          yield* rpc.request({ type: "set_model", provider, modelId });
          const result = yield* rpc.request({ type: "get_available_thinking_levels" });
          return isRecord(result) && Array.isArray(result.levels)
            ? result.levels.filter((level): level is string => typeof level === "string")
            : ["off"];
        }).pipe(
          Effect.orElseSucceed(() =>
            model.reasoning === true ? ["off", "low", "medium", "high"] : ["off"],
          ),
        );
        return {
          slug,
          name: typeof model.name === "string" && model.name.trim() ? model.name.trim() : modelId,
          subProvider: provider,
          isCustom: false,
          ...(slug === stateModel ? { isDefault: true } : {}),
          capabilities: capabilitiesForThinkingLevels(
            levels,
            slug === stateModel ? stateThinking : undefined,
          ),
        } satisfies ServerProviderModel;
      }),
    ).pipe(Effect.map((models) => models.flatMap((model) => (model ? [model] : []))));
  }).pipe(Effect.scoped);

const runVersion = (settings: PiSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const command = yield* resolveSpawnCommand(settings.binaryPath, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      settings.binaryPath,
      ChildProcess.make(command.command, command.args, {
        env: environment,
        shell: command.shell,
      }),
    );
  });

export const buildInitialPiProviderSnapshot = (enabled: boolean) =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    return buildServerProvider({
      driver: DRIVER,
      presentation: PRESENTATION,
      enabled,
      checkedAt,
      models: [],
      probe: enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking Pi CLI availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Pi is disabled in T3 Code settings.",
          },
    });
  });

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  settings: PiSettings,
  enabled: boolean,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  if (!enabled) return yield* buildInitialPiProviderSnapshot(false);

  const versionResult = yield* runVersion(settings, environment).pipe(
    Effect.timeoutOption(VERSION_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    return buildServerProvider({
      driver: DRIVER,
      presentation: PRESENTATION,
      enabled,
      checkedAt,
      models: [],
      probe: {
        installed: !isCommandMissingCause(versionResult.failure),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(versionResult.failure)
          ? "Pi CLI (`pi`) is not installed or not on PATH."
          : "Failed to execute the Pi CLI health check.",
      },
    });
  }
  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      driver: DRIVER,
      presentation: PRESENTATION,
      enabled,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI timed out while reporting its version.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return buildServerProvider({
      driver: DRIVER,
      presentation: PRESENTATION,
      enabled,
      checkedAt,
      models: [],
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Pi CLI is installed but failed to run.",
      },
    });
  }

  const discovery = yield* discoverPiModels(settings, environment).pipe(
    Effect.timeoutOption(DISCOVERY_TIMEOUT_MS),
    Effect.result,
  );
  const models =
    Result.isSuccess(discovery) && Option.isSome(discovery.success) ? discovery.success.value : [];
  const message = Result.isFailure(discovery)
    ? "Pi RPC model discovery failed. Check the Pi configuration and server logs."
    : Option.isNone(discovery.success)
      ? "Pi RPC model discovery timed out."
      : models.length === 0
        ? "Pi is installed, but no authenticated models are available. Run `pi` to configure authentication."
        : undefined;

  return buildServerProvider({
    driver: DRIVER,
    presentation: PRESENTATION,
    enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: models.length > 0 ? "ready" : "warning",
      auth: { status: models.length > 0 ? "authenticated" : "unauthenticated" },
      ...(message ? { message } : {}),
    },
  });
});
