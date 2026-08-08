import {
  ApprovalRequestId,
  type AcpSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
  type ProviderSessionStartInput,
  type ProviderSendTurnInput,
  type ProviderTurnStartResult,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import {
  applyAcpModelSelection,
  currentAcpModelIdFromSessionSetup,
  makeAcpGenericRuntime,
  resolveAcpBaseModelId,
  selectAcpPermissionOptionId,
} from "../acp/AcpGenericSupport.ts";

const PROVIDER = ProviderDriverKind.make("acp");

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

type PendingUserInputResolution =
  | { readonly _tag: "answered"; readonly answers: ProviderUserInputAnswers }
  | { readonly _tag: "cancelled" };

interface PendingUserInput {
  readonly resolution: Deferred.Deferred<PendingUserInputResolution>;
}

interface AcpSessionContext {
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  session: ProviderSession;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly promptsInFlight: Map<TurnId, number>;
  activeTurnId: TurnId | undefined;
  currentModelId: string | undefined;
  stopped: boolean;
}

function settleApprovals(m: ReadonlyMap<ApprovalRequestId, PendingApproval>): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(m.values()),
    (p) => Deferred.succeed(p.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

function settleUserInputs(
  m: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(m.values()),
    (p) => Deferred.succeed(p.resolution, { _tag: "cancelled" }).pipe(Effect.ignore),
    { discard: true },
  );
}

// ponytail: minimal ACP adapter following GrokAdapter's runtime pattern
export function makeAcpAdapter(
  acpSettings: AcpSettings,
  options: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly instanceId: ProviderInstanceId;
  },
) {
  return Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const sessions = new Map<ThreadId, AcpSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const publish = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, {
        ...event,
        providerInstanceId: options.instanceId,
      }).pipe(Effect.asVoid);

    const getSem = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing = Option.fromNullishOr(current.get(threadId));
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((sem) => {
                const next = new Map(current);
                next.set(threadId, sem);
                return [sem, next] as const;
              }),
            ),
          onSome: (sem) => Effect.succeed([sem, current] as const),
        });
      });

    const withLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getSem(threadId), (sem) => sem.withPermit(effect));

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<AcpSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const stopInternal = (ctx: AcpSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settleApprovals(ctx.pendingApprovals);
        yield* settleUserInputs(ctx.pendingUserInputs);
        yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.ignore);
        sessions.delete(ctx.session.threadId);
      });

    // Build notification handler for non-permission session updates
    const mkNotify =
      (threadId: ThreadId) =>
      (notification: EffectAcpSchema.SessionNotification): Effect.Effect<void> =>
        Effect.gen(function* () {
          const ctx = sessions.get(threadId);
          if (!ctx || ctx.stopped) return;
          const update = notification.update;
          const turnId = ctx.activeTurnId;

          if (update.sessionUpdate === "agent_message_chunk" && turnId) {
            const content = update.content;
            if (content.type === "text" && content.text) {
              yield* publish(
                makeAcpContentDeltaEvent({
                  stamp: yield* makeStamp(),
                  provider: PROVIDER,
                  threadId,
                  turnId,
                  text: content.text,
                  rawPayload: notification,
                }),
              );
            }
            return;
          }

          if (update.sessionUpdate === "tool_call" && turnId) {
            // ponytail: tool_call events come through the ACP session; skip for now
            return;
          }
        }).pipe(Effect.orDie);

    // ── startSession ──
    const startSession = (
      input: ProviderSessionStartInput,
    ): Effect.Effect<ProviderSession, ProviderAdapterError> =>
      withLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected '${PROVIDER}' but received '${input.provider}'.`,
            });
          }

          const threadId = input.threadId;
          const existing = sessions.get(threadId);
          if (existing && !existing.stopped) {
            yield* stopInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let scopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            scopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );

          const cwd = input.cwd ?? process.cwd();

          // Build runtime
          const acp = yield* makeAcpGenericRuntime({
            acpSettings,
            environment: options.environment ?? process.env,
            childProcessSpawner: spawner,
            cwd,
            clientInfo: { name: "t3-code-acp", version: "0.0.0" },
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId,
                  detail: cause.message ?? "ACP runtime creation failed.",
                  cause,
                }),
            ),
          );

          // Register permission handler BEFORE start
          yield* acp.handleRequestPermission((params: EffectAcpSchema.RequestPermissionRequest) =>
            Effect.gen(function* () {
              const permissionRequest = parsePermissionRequest(params);
              const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
              const runtimeRequestId = RuntimeRequestId.make(requestId);
              const decision = yield* Deferred.make<ProviderApprovalDecision>();
              const turnId = sessions.get(threadId)?.activeTurnId;
              pendingApprovals.set(requestId, { decision });

              yield* publish(
                makeAcpRequestOpenedEvent({
                  stamp: yield* makeStamp(),
                  provider: PROVIDER,
                  threadId,
                  turnId,
                  requestId: runtimeRequestId,
                  permissionRequest: permissionRequest ?? params,
                  detail: permissionRequest?.detail ?? "Permission requested",
                  args: params,
                  source: "acp.jsonrpc",
                  method: "session/request_permission",
                  rawPayload: params,
                }),
              );

              const resolved = yield* Deferred.await(decision);
              pendingApprovals.delete(requestId);

              yield* publish(
                makeAcpRequestResolvedEvent({
                  stamp: yield* makeStamp(),
                  provider: PROVIDER,
                  threadId,
                  turnId,
                  requestId: runtimeRequestId,
                  permissionRequest: permissionRequest ?? params,
                  decision: resolved,
                }),
              );

              if (resolved === "cancel") {
                return { outcome: { outcome: "cancelled" } as const };
              }
              const optionId = selectAcpPermissionOptionId(params, resolved) ?? "";
              if (!optionId) return { outcome: { outcome: "cancelled" } as const };
              return {
                outcome: { outcome: "selected" as const, optionId },
              };
            }).pipe(Effect.catchCause(() => Effect.die("ACP permission handler failed"))),
          );

          // Start the session
          const started = yield* acp
            .start()
            .pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, threadId, "session/start", error),
              ),
            );

          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: options.instanceId,
            threadId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: input.modelSelection?.model,
            activeTurnId: undefined,
            resumeCursor: { sessionId: started.sessionId },
            createdAt: yield* nowIso,
            updatedAt: yield* nowIso,
          };

          const ctx: AcpSessionContext = {
            scope: sessionScope,
            acp,
            session,
            pendingApprovals,
            pendingUserInputs,
            promptsInFlight: new Map(),
            activeTurnId: undefined,
            currentModelId: currentAcpModelIdFromSessionSetup(started.sessionSetupResult),
            stopped: false,
          };

          // Register notification handler AFTER start
          yield* acp.handleSessionUpdate(mkNotify(threadId));

          scopeTransferred = true;
          sessions.set(threadId, ctx);

          return session;
        }).pipe(Effect.scoped),
      );

    // ── sendTurn ──
    const sendTurn = (
      input: ProviderSendTurnInput,
    ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> =>
      Effect.gen(function* () {
        const prepared = yield* withLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(input.threadId);
            const activePromptCount = ctx.activeTurnId
              ? (ctx.promptsInFlight.get(ctx.activeTurnId) ?? 0)
              : 0;
            const turnId =
              activePromptCount > 0 && ctx.activeTurnId
                ? ctx.activeTurnId
                : TurnId.make(yield* randomUUIDv4);
            const isNewTurn = activePromptCount === 0;

            if (input.modelSelection && isNewTurn) {
              ctx.currentModelId = yield* applyAcpModelSelection({
                runtime: ctx.acp,
                currentModelId: ctx.currentModelId,
                requestedModelId: resolveAcpBaseModelId(input.modelSelection.model),
                mapError: (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/set_model",
                    detail: "Failed to set model.",
                    cause,
                  }),
              });
            }

            ctx.promptsInFlight.set(turnId, activePromptCount + 1);
            ctx.activeTurnId = turnId;
            ctx.session = {
              ...ctx.session,
              status: "running",
              activeTurnId: turnId,
              updatedAt: yield* nowIso,
              ...(ctx.currentModelId ? { model: resolveAcpBaseModelId(ctx.currentModelId) } : {}),
            };

            if (isNewTurn) {
              yield* publish({
                type: "turn.started",
                ...(yield* makeStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: ctx.session.model ? { model: ctx.session.model } : {},
              });
            }

            return { acp: ctx.acp, turnId };
          }),
        );

        const promptExit = yield* prepared.acp
          .prompt({ prompt: [{ type: "text", text: input.input ?? "" }] })
          .pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
            ),
            Effect.exit,
          );

        yield* withLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = sessions.get(input.threadId);
            if (!ctx || ctx.stopped) return;
            const promptCount = ctx.promptsInFlight.get(prepared.turnId);
            if (promptCount === undefined) return;
            if (promptCount > 1) {
              ctx.promptsInFlight.set(prepared.turnId, promptCount - 1);
              return;
            }
            ctx.promptsInFlight.delete(prepared.turnId);
            if (ctx.activeTurnId !== prepared.turnId) return;

            ctx.activeTurnId = undefined;
            const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
            ctx.session = {
              ...readySession,
              status: "ready",
              updatedAt: yield* nowIso,
            };
            yield* publish({
              type: "turn.completed",
              ...(yield* makeStamp()),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId: prepared.turnId,
              payload: Exit.isFailure(promptExit)
                ? { state: "failed", errorMessage: "ACP prompt failed." }
                : {
                    state: promptExit.value.stopReason === "cancelled" ? "cancelled" : "completed",
                    stopReason: promptExit.value.stopReason,
                  },
            });
          }),
        );

        if (Exit.isFailure(promptExit)) {
          return yield* Effect.failCause(promptExit.cause);
        }
        return {
          threadId: input.threadId,
          turnId: prepared.turnId,
          resumeCursor: sessions.get(input.threadId)?.session.resumeCursor,
        } satisfies ProviderTurnStartResult;
      });

    // ── interruptTurn ──
    const interruptTurn = (
      threadId: ThreadId,
      _turnId?: TurnId,
    ): Effect.Effect<void, ProviderAdapterError> =>
      Effect.gen(function* () {
        const prepared = yield* withLock(
          threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(threadId);
            const interruptedTurnId = ctx.activeTurnId;
            yield* settleApprovals(ctx.pendingApprovals);
            yield* settleUserInputs(ctx.pendingUserInputs);
            if (interruptedTurnId) {
              ctx.promptsInFlight.delete(interruptedTurnId);
            }
            ctx.activeTurnId = undefined;
            const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
            ctx.session = {
              ...readySession,
              status: "ready",
              updatedAt: yield* nowIso,
            };
            if (interruptedTurnId) {
              yield* publish({
                type: "turn.completed",
                ...(yield* makeStamp()),
                provider: PROVIDER,
                threadId,
                turnId: interruptedTurnId,
                payload: { state: "cancelled", stopReason: "cancelled" },
              });
            }
            return ctx;
          }),
        );
        yield* prepared.acp.cancel.pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
          ),
          Effect.tapError(() =>
            withLock(
              threadId,
              Effect.suspend(() =>
                sessions.get(threadId) === prepared ? stopInternal(prepared) : Effect.void,
              ),
            ),
          ),
        );
      });

    // ── respondToRequest ──
    const respondToRequest = (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      decision: ProviderApprovalDecision,
    ): Effect.Effect<void, ProviderAdapterError> =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "respondToRequest",
            detail: `No pending approval '${requestId}'.`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    // ── respondToUserInput ──
    const respondToUserInput = (
      threadId: ThreadId,
      requestId: ApprovalRequestId,
      answers: ProviderUserInputAnswers,
    ): Effect.Effect<void, ProviderAdapterError> =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "respondToUserInput",
            detail: `No pending user input '${requestId}'.`,
          });
        }
        yield* Deferred.succeed(pending.resolution, { _tag: "answered", answers });
      });

    // ── stopSession ──
    const stopSession = (threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
      withLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopInternal(ctx);
        }),
      );

    // ── listSessions ──
    const listSessions = (): Effect.Effect<ReadonlyArray<ProviderSession>> =>
      Effect.sync(() => Array.from(sessions.values(), (c) => c.session));

    // ── hasSession ──
    const hasSession = (threadId: ThreadId): Effect.Effect<boolean> =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    // ── stopAll ──
    const stopAll = (): Effect.Effect<void> =>
      Effect.forEach(Array.from(sessions.values()), stopInternal, { discard: true });

    // ── readThread ──
    const readThread = (
      threadId: ThreadId,
    ): Effect.Effect<
      {
        readonly threadId: ThreadId;
        readonly turns: ReadonlyArray<{
          readonly id: TurnId;
          readonly items: ReadonlyArray<unknown>;
        }>;
      },
      ProviderAdapterError
    > => Effect.succeed({ threadId, turns: [] });

    // ── rollbackThread ──
    const rollbackThread = (
      _threadId: ThreadId,
      _numTurns: number,
    ): Effect.Effect<
      {
        readonly threadId: ThreadId;
        readonly turns: ReadonlyArray<{
          readonly id: TurnId;
          readonly items: ReadonlyArray<unknown>;
        }>;
      },
      ProviderAdapterError
    > =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollbackThread",
          detail: "ACP sessions do not support rollback.",
        }),
      );

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(
        Effect.ignore,
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" as const },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      readThread,
      rollbackThread,
      streamEvents,
    };
  });
}
