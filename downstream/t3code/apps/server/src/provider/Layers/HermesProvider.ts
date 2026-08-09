import type { HermesSettings, ServerProvider, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { discoverHermesSkills } from "../Drivers/HermesSkills.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PRESENTATION = {
  displayName: "Hermes",
  badgeLabel: "Downstream",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: true,
} as const;
const CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const TIMEOUT_MS = 4_000;
const MINIMUM_VERSION = [0, 20, 0] as const;

export function isSupportedHermesVersion(version: string | null): boolean {
  if (!version) return false;
  const parts = version.split(".").map(Number);
  for (let index = 0; index < MINIMUM_VERSION.length; index += 1) {
    const part = parts[index] ?? 0;
    if (part !== MINIMUM_VERSION[index]) return part > MINIMUM_VERSION[index]!;
  }
  return true;
}

export function hermesProfileModel(profile: string): ServerProviderModel {
  const name = profile.trim() || "default";
  return {
    slug: `hermes/${name}`,
    name: `Hermes · ${name}`,
    isCustom: false,
    isDefault: true,
    capabilities: CAPABILITIES,
  };
}

const runVersion = (settings: HermesSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const binary = settings.binaryPath || "hermes";
    const command = yield* resolveSpawnCommand(binary, ["--version"], { env: environment });
    return yield* spawnAndCollect(
      binary,
      ChildProcess.make(command.command, command.args, {
        env: environment,
        shell: command.shell,
      }),
    );
  });

export const buildInitialHermesProviderSnapshot = (settings: HermesSettings) =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: [hermesProfileModel(settings.profile)],
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking Hermes availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Hermes is disabled in settings.",
          },
    });
  });

export const checkHermesProviderStatus = Effect.fn("checkHermesProviderStatus")(function* (
  settings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  if (!settings.enabled) return yield* buildInitialHermesProviderSnapshot(settings);
  const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  const result = yield* runVersion(settings, environment).pipe(
    Effect.timeoutOption(TIMEOUT_MS),
    Effect.result,
  );
  const skillsResult = yield* discoverHermesSkills(settings, environment).pipe(Effect.result);
  const skills = Result.isSuccess(skillsResult) ? skillsResult.success : [];
  const model = hermesProfileModel(settings.profile);

  if (Result.isFailure(result)) {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: [model],
      skills,
      probe: {
        installed: !isCommandMissingCause(result.failure),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(result.failure)
          ? "Hermes CLI (`hermes`) is not installed or not on PATH."
          : "Failed to execute the Hermes CLI health check.",
      },
    });
  }
  if (Option.isNone(result.success)) {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: [model],
      skills,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Hermes CLI timed out while reporting its version.",
      },
    });
  }

  const command = result.success.value;
  const version = parseGenericCliVersion(`${command.stdout}\n${command.stderr}`);
  const supported = command.code === 0 && isSupportedHermesVersion(version);
  const skillProbeFailed = Result.isFailure(skillsResult);
  return buildServerProvider({
    presentation: PRESENTATION,
    enabled: true,
    checkedAt,
    models: [model],
    skills,
    probe: {
      installed: true,
      version,
      status: supported ? (skillProbeFailed ? "warning" : "ready") : "error",
      auth: { status: supported ? "authenticated" : "unknown" },
      ...(supported
        ? skillProbeFailed
          ? { message: "Hermes is ready, but its enabled skill catalog could not be loaded." }
          : {}
        : {
            message:
              command.code !== 0
                ? "Hermes CLI is installed but failed to run."
                : "Hermes 0.20.0 or newer is required for shared ACP sessions.",
          }),
    },
  });
});
