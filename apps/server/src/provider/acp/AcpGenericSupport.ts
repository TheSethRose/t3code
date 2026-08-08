import {
  type AcpSettings,
  type ProviderApprovalDecision,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const ACP_DRIVER_KIND = ProviderDriverKind.make("acp");

type AcpGenericRuntimeAcpSettings = Pick<AcpSettings, "binaryPath" | "launchArgs" | "authMethodId">;

interface AcpGenericRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly acpSettings: AcpGenericRuntimeAcpSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

function parseLaunchArgs(rawArgs: string | undefined): ReadonlyArray<string> {
  const trimmed = rawArgs?.trim();
  if (!trimmed) return ["acp"];
  return trimmed.split(/\s+/).filter(Boolean);
}

export function buildAcpGenericSpawnInput(
  acpSettings: AcpGenericRuntimeAcpSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: acpSettings?.binaryPath || "hermes",
    args: parseLaunchArgs(acpSettings?.launchArgs),
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

function resolveAcpAuthMethodId(
  acpSettings: AcpGenericRuntimeAcpSettings | null | undefined,
): string {
  const configured = acpSettings?.authMethodId?.trim();
  if (configured && configured.length > 0) return configured;
  // Empty string = auto-select via AcpSessionRuntime
  return "";
}

// ponytail: single factory, same ACP runtime as Cursor/Grok
export const makeAcpGenericRuntime = (
  input: AcpGenericRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const authMethodId = resolveAcpAuthMethodId(input.acpSettings);
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildAcpGenericSpawnInput(input.acpSettings, input.cwd, input.environment),
        authMethodId,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export function resolveAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : "acp/default";
  return normalizeModelSlug(base, ACP_DRIVER_KIND) ?? "acp/default";
}

export function currentAcpModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function applyAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const shouldSwitchModel =
    input.requestedModelId !== undefined && input.requestedModelId !== input.currentModelId;
  if (!shouldSwitchModel) return Effect.succeed(input.currentModelId);
  return input.runtime
    .setSessionModel(input.requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(input.requestedModelId));
}

export function selectAcpPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const preferredOptionId =
    decision === "acceptForSession"
      ? "allow_session"
      : decision === "accept"
        ? "allow_once"
        : "deny";
  const kind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  return (
    request.options.find((option) => option.optionId === preferredOptionId) ??
    request.options.find((option) => option.kind === kind)
  )?.optionId;
}
