import {
  ApprovalRequestId,
  EventId,
  ProviderItemId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type PiSettings,
  type ModelSelection,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import {
  PI_APPROVAL_ALLOW_ONCE,
  PI_APPROVAL_ALLOW_SESSION,
  PI_APPROVAL_EXTENSION_SOURCE,
  PI_APPROVAL_REJECT,
  PI_APPROVAL_TITLE_PREFIX,
} from "../pi/PiApprovalExtension.ts";
import {
  makePiRpcClient,
  PiRpcError,
  resolvePiLaunchArgs,
  type PiRpcClient,
} from "../pi/PiRpcClient.ts";

const PROVIDER = ProviderDriverKind.make("pi");
const PI_RESUME_VERSION = 1;

type PiAdapterShape = ProviderAdapterShape<
  | ProviderAdapterProcessError
  | ProviderAdapterRequestError
  | ProviderAdapterSessionNotFoundError
  | ProviderAdapterValidationError
>;

interface PendingApproval {
  readonly piRequestId: string;
  readonly requestType:
    | "command_execution_approval"
    | "file_read_approval"
    | "file_change_approval"
    | "dynamic_tool_call";
}

interface PendingUserInput {
  readonly piRequestId: string;
  readonly method: string;
  readonly questionId: string;
}

interface PiSessionContext {
  readonly threadId: ThreadId;
  readonly scope: Scope.Closeable;
  readonly rpc: PiRpcClient;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  lastTurnError: string | undefined;
  stopped: boolean;
}

interface PiState {
  readonly sessionId?: unknown;
  readonly sessionFile?: unknown;
  readonly model?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parsePiResume(value: unknown): { readonly sessionId: string } | undefined {
  if (!isRecord(value) || value.schemaVersion !== PI_RESUME_VERSION) return undefined;
  const sessionId = readString(value, "sessionId");
  return sessionId ? { sessionId } : undefined;
}

function splitPiModelSlug(slug: string): { readonly provider: string; readonly modelId: string } {
  const separator = slug.indexOf("/");
  if (separator <= 0 || separator === slug.length - 1) {
    throw new PiRpcError({
      operation: "set_model",
      detail: `Expected a Pi model slug in 'provider/model' form, received '${slug}'.`,
    });
  }
  return { provider: slug.slice(0, separator), modelId: slug.slice(separator + 1) };
}

function toolItemType(toolName: string) {
  if (toolName === "bash") return "command_execution" as const;
  if (toolName === "edit" || toolName === "write") return "file_change" as const;
  return "dynamic_tool_call" as const;
}

function approvalRequestType(toolName: string): PendingApproval["requestType"] {
  if (toolName === "bash") return "command_execution_approval";
  if (toolName === "edit" || toolName === "write") return "file_change_approval";
  if (["read", "grep", "find", "ls"].includes(toolName)) return "file_read_approval";
  return "dynamic_tool_call";
}

function toolResultText(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.content)) return undefined;
  const text = value.content
    .flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
    .join("\n")
    .trim();
  return text || undefined;
}

function parseApprovalTitle(
  title: string | undefined,
): { readonly toolName: string; readonly input: unknown } | undefined {
  if (!title?.startsWith(PI_APPROVAL_TITLE_PREFIX)) return undefined;
  try {
    const value = JSON.parse(title.slice(PI_APPROVAL_TITLE_PREFIX.length)) as unknown;
    if (!isRecord(value)) return undefined;
    const toolName = readString(value, "toolName");
    return toolName ? { toolName, input: value.input } : undefined;
  } catch {
    return undefined;
  }
}

function firstAnswer(answers: ProviderUserInputAnswers, questionId: string): unknown {
  return answers[questionId] ?? Object.values(answers)[0];
}

export const makePiAdapter = Effect.fn("makePiAdapter")(function* (
  piSettings: PiSettings,
  options: {
    readonly instanceId: ProviderInstanceId;
    readonly environment: NodeJS.ProcessEnv;
  },
) {
  const adapterScope = yield* Scope.Scope;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* ServerConfig;
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, PiSessionContext>();
  const extensionPath = yield* fileSystem.makeTempFileScoped({
    prefix: "t3-pi-approval-",
    suffix: ".mjs",
  });
  yield* fileSystem.writeFileString(extensionPath, PI_APPROVAL_EXTENSION_SOURCE);

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const nextId = crypto.randomUUIDv4.pipe(Effect.orDie);
  const emit = (event: ProviderRuntimeEvent) => PubSub.publish(events, event).pipe(Effect.asVoid);
  const eventBase = (ctx: PiSessionContext, event: unknown) =>
    Effect.gen(function* () {
      return {
        eventId: EventId.make(yield* nextId),
        provider: PROVIDER,
        providerInstanceId: options.instanceId,
        threadId: ctx.threadId,
        createdAt: yield* nowIso,
        ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
        raw: { source: "pi.rpc" as const, payload: event },
      };
    });

  const mapRequestError = (method: string, cause: PiRpcError) =>
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method,
      detail: cause.message,
      cause,
    });

  const requireSession = (threadId: ThreadId) => {
    const context = sessions.get(threadId);
    return context && !context.stopped
      ? Effect.succeed(context)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const applyModelSelection = (rpc: PiRpcClient, modelSelection: ModelSelection | undefined) =>
    Effect.gen(function* () {
      if (!modelSelection) return;
      const model = splitPiModelSlug(modelSelection.model);
      yield* rpc.request({ type: "set_model", ...model });
      const thinking = getModelSelectionStringOptionValue(modelSelection, "thinkingLevel");
      if (thinking) {
        yield* rpc.request({ type: "set_thinking_level", level: thinking });
      }
    });

  const emitUsage = (ctx: PiSessionContext, stats: unknown) =>
    Effect.gen(function* () {
      if (!isRecord(stats)) return;
      const tokens = isRecord(stats.tokens) ? stats.tokens : undefined;
      const contextUsage = isRecord(stats.contextUsage) ? stats.contextUsage : undefined;
      const usedTokens =
        typeof contextUsage?.tokens === "number"
          ? Math.max(0, Math.floor(contextUsage.tokens))
          : typeof tokens?.total === "number"
            ? Math.max(0, Math.floor(tokens.total))
            : 0;
      yield* emit({
        ...(yield* eventBase(ctx, { type: "get_session_stats", data: stats })),
        type: "thread.token-usage.updated",
        payload: {
          usage: {
            usedTokens,
            ...(typeof tokens?.total === "number"
              ? { totalProcessedTokens: Math.max(0, Math.floor(tokens.total)) }
              : {}),
            ...(typeof contextUsage?.contextWindow === "number" && contextUsage.contextWindow > 0
              ? { maxTokens: Math.floor(contextUsage.contextWindow) }
              : {}),
            ...(typeof tokens?.input === "number"
              ? { inputTokens: Math.max(0, Math.floor(tokens.input)) }
              : {}),
            ...(typeof tokens?.cacheRead === "number"
              ? { cachedInputTokens: Math.max(0, Math.floor(tokens.cacheRead)) }
              : {}),
            ...(typeof tokens?.output === "number"
              ? { outputTokens: Math.max(0, Math.floor(tokens.output)) }
              : {}),
            ...(typeof stats.toolCalls === "number"
              ? { toolUses: Math.max(0, Math.floor(stats.toolCalls)) }
              : {}),
            compactsAutomatically: true,
          },
        },
      });
    });

  const handlePiEvent = (ctx: PiSessionContext, value: unknown) =>
    Effect.gen(function* () {
      if (!isRecord(value)) return;
      const type = readString(value, "type");
      if (!type) return;

      if (type === "message_update" && isRecord(value.assistantMessageEvent)) {
        const update = value.assistantMessageEvent;
        const updateType = readString(update, "type");
        if (updateType === "text_delta" || updateType === "thinking_delta") {
          const delta = typeof update.delta === "string" ? update.delta : "";
          if (!delta) return;
          const suffix = updateType === "text_delta" ? "assistant" : "reasoning";
          yield* emit({
            ...(yield* eventBase(ctx, value)),
            type: "content.delta",
            itemId: RuntimeItemId.make(`${ctx.activeTurnId ?? "pi"}:${suffix}`),
            payload: {
              streamKind: updateType === "text_delta" ? "assistant_text" : "reasoning_text",
              delta,
              ...(typeof update.contentIndex === "number"
                ? { contentIndex: Math.floor(update.contentIndex) }
                : {}),
            },
          });
        } else if (updateType === "error") {
          ctx.lastTurnError =
            readString(update, "error") ?? readString(update, "reason") ?? "Pi failed.";
        }
        return;
      }

      if (type === "tool_execution_start") {
        const toolCallId = readString(value, "toolCallId");
        const toolName = readString(value, "toolName");
        if (!toolCallId || !toolName) return;
        yield* emit({
          ...(yield* eventBase(ctx, value)),
          type: "item.started",
          itemId: RuntimeItemId.make(toolCallId),
          providerRefs: { providerItemId: ProviderItemId.make(toolCallId) },
          payload: {
            itemType: toolItemType(toolName),
            status: "inProgress",
            title: toolName,
            data: value.args,
          },
        });
        return;
      }

      if (type === "tool_execution_update" || type === "tool_execution_end") {
        const toolCallId = readString(value, "toolCallId");
        const toolName = readString(value, "toolName");
        if (!toolCallId || !toolName) return;
        const result = type === "tool_execution_end" ? value.result : value.partialResult;
        const isError = value.isError === true;
        yield* emit({
          ...(yield* eventBase(ctx, value)),
          type: type === "tool_execution_end" ? "item.completed" : "item.updated",
          itemId: RuntimeItemId.make(toolCallId),
          providerRefs: { providerItemId: ProviderItemId.make(toolCallId) },
          payload: {
            itemType: toolItemType(toolName),
            status:
              type === "tool_execution_end" ? (isError ? "failed" : "completed") : "inProgress",
            title: toolName,
            ...(toolResultText(result) ? { detail: toolResultText(result) } : {}),
            data: result,
          },
        });
        return;
      }

      if (type === "extension_ui_request") {
        const piRequestId = readString(value, "id");
        const method = readString(value, "method");
        if (!piRequestId || !method) return;
        const approval = parseApprovalTitle(readString(value, "title"));
        if (approval) {
          const requestId = ApprovalRequestId.make(yield* nextId);
          const requestType = approvalRequestType(approval.toolName);
          ctx.pendingApprovals.set(requestId, { piRequestId, requestType });
          yield* emit({
            ...(yield* eventBase(ctx, value)),
            type: "request.opened",
            requestId: RuntimeRequestId.make(requestId),
            providerRefs: { providerRequestId: piRequestId },
            payload: {
              requestType,
              detail: `Allow Pi to run ${approval.toolName}?`,
              args: approval.input,
            },
          });
          return;
        }

        if (["select", "confirm", "input", "editor"].includes(method)) {
          const requestId = ApprovalRequestId.make(yield* nextId);
          const questionId = `pi-${piRequestId}`;
          ctx.pendingUserInputs.set(requestId, { piRequestId, method, questionId });
          const options =
            method === "confirm"
              ? [
                  { label: "Yes", description: "Confirm" },
                  { label: "No", description: "Cancel" },
                ]
              : Array.isArray(value.options)
                ? value.options.flatMap((option) =>
                    typeof option === "string"
                      ? [{ label: option, description: `Choose ${option}` }]
                      : [],
                  )
                : [];
          yield* emit({
            ...(yield* eventBase(ctx, value)),
            type: "user-input.requested",
            requestId: RuntimeRequestId.make(requestId),
            providerRefs: { providerRequestId: piRequestId },
            payload: {
              questions: [
                {
                  id: questionId,
                  header: "Pi",
                  question:
                    readString(value, "title") ?? readString(value, "message") ?? "Pi needs input.",
                  options,
                  multiSelect: false,
                },
              ],
            },
          });
        }
        return;
      }

      if (type === "agent_settled" && ctx.activeTurnId) {
        const turnId = ctx.activeTurnId;
        const errorMessage = ctx.lastTurnError;
        ctx.activeTurnId = undefined;
        ctx.lastTurnError = undefined;
        const updatedAt = yield* nowIso;
        const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
        ctx.session = { ...readySession, status: "ready", updatedAt };
        const stats = yield* ctx.rpc
          .request({ type: "get_session_stats" })
          .pipe(Effect.orElseSucceed(() => undefined));
        yield* emitUsage(ctx, stats);
        yield* emit({
          ...(yield* eventBase(ctx, value)),
          type: "turn.completed",
          turnId,
          payload: errorMessage
            ? { state: "failed", errorMessage }
            : { state: "completed", stopReason: "stop" },
        });
        return;
      }

      if (type === "extension_error") {
        const message = readString(value, "error") ?? "A Pi extension failed.";
        yield* emit({
          ...(yield* eventBase(ctx, value)),
          type: "runtime.error",
          payload: { message, class: "provider_error", detail: value },
        });
      }
    });

  const stopContext = (ctx: PiSessionContext) =>
    Effect.gen(function* () {
      if (ctx.stopped) return;
      ctx.stopped = true;
      yield* Scope.close(ctx.scope, Exit.void).pipe(Effect.ignore);
      sessions.delete(ctx.threadId);
    });

  const startSession: PiAdapterShape["startSession"] = (input) =>
    Effect.gen(function* () {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }
      if (!input.cwd?.trim()) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "cwd is required and must be non-empty.",
        });
      }
      const cwd = input.cwd.trim();
      const previous = sessions.get(input.threadId);
      if (previous) yield* stopContext(previous);

      const sessionScope = yield* Scope.make("sequential");
      const resume = parsePiResume(input.resumeCursor);
      const created = yield* Effect.gen(function* () {
        const launchArgs = resolvePiLaunchArgs(piSettings.launchArgs);
        const rpc = yield* makePiRpcClient({
          binaryPath: piSettings.binaryPath,
          args: [
            ...launchArgs,
            "--extension",
            extensionPath,
            ...(resume ? ["--session-id", resume.sessionId] : []),
          ],
          cwd,
          environment: {
            ...options.environment,
            T3_PI_APPROVAL_MODE: input.runtimeMode,
          },
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(Scope.Scope, sessionScope),
        );
        const selection =
          input.modelSelection?.instanceId === options.instanceId
            ? input.modelSelection
            : undefined;
        yield* applyModelSelection(rpc, selection);
        const state = yield* rpc.request<PiState>({ type: "get_state" });
        const sessionId =
          typeof state?.sessionId === "string" ? state.sessionId : resume?.sessionId;
        if (!sessionId) {
          return yield* new PiRpcError({
            operation: "get_state",
            detail: "Pi did not return a session ID.",
          });
        }
        const timestamp = yield* nowIso;
        const resumeCursor = { schemaVersion: PI_RESUME_VERSION, sessionId };
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: options.instanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd,
          ...(selection ? { model: selection.model } : {}),
          threadId: input.threadId,
          resumeCursor,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        const ctx: PiSessionContext = {
          threadId: input.threadId,
          scope: sessionScope,
          rpc,
          pendingApprovals: new Map(),
          pendingUserInputs: new Map(),
          session,
          activeTurnId: undefined,
          lastTurnError: undefined,
          stopped: false,
        };
        sessions.set(input.threadId, ctx);
        yield* rpc.events.pipe(
          Stream.runForEach((event) => handlePiEvent(ctx, event)),
          Effect.catchCause((cause) =>
            Effect.logError("Pi RPC event stream failed.", { cause, threadId: input.threadId }),
          ),
          Effect.forkIn(sessionScope),
        );
        yield* emit({
          ...(yield* eventBase(ctx, { type: "session_started", state })),
          type: "session.started",
          payload: { message: "Pi RPC session started.", resume: resumeCursor },
        });
        return session;
      }).pipe(Effect.result);

      if (created._tag === "Failure") {
        yield* Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);
        return yield* new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: created.failure.message,
          cause: created.failure,
        });
      }
      return created.success;
    });

  const sendTurn: PiAdapterShape["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(input.threadId);
      const images = yield* Effect.forEach(input.attachments ?? [], (attachment) =>
        Effect.gen(function* () {
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) return undefined;
          const bytes = yield* fileSystem.readFile(attachmentPath);
          return {
            type: "image" as const,
            data: Buffer.from(bytes).toString("base64"),
            mimeType: attachment.mimeType,
          };
        }).pipe(Effect.orElseSucceed(() => undefined)),
      );
      const promptImages = images.filter((image) => image !== undefined);
      if (ctx.activeTurnId) {
        yield* ctx.rpc
          .request({
            type: "steer",
            message: input.input ?? "Continue with the attached context.",
            ...(promptImages.length > 0 ? { images: promptImages } : {}),
          })
          .pipe(Effect.mapError((cause) => mapRequestError("steer", cause)));
        return {
          threadId: input.threadId,
          turnId: ctx.activeTurnId,
          resumeCursor: ctx.session.resumeCursor,
        };
      }

      const selection =
        input.modelSelection?.instanceId === options.instanceId ? input.modelSelection : undefined;
      yield* applyModelSelection(ctx.rpc, selection).pipe(
        Effect.mapError((cause) => mapRequestError("set_model", cause)),
      );
      const turnId = TurnId.make(yield* nextId);
      const updatedAt = yield* nowIso;
      ctx.activeTurnId = turnId;
      ctx.session = {
        ...ctx.session,
        status: "running",
        ...(selection ? { model: selection.model } : {}),
        activeTurnId: turnId,
        updatedAt,
      };
      yield* emit({
        ...(yield* eventBase(ctx, { type: "prompt" })),
        type: "turn.started",
        turnId,
        payload: {
          ...(selection ? { model: selection.model } : {}),
          ...(getModelSelectionStringOptionValue(selection, "thinkingLevel")
            ? { effort: getModelSelectionStringOptionValue(selection, "thinkingLevel") }
            : {}),
        },
      });
      yield* ctx.rpc
        .request({
          type: "prompt",
          message: input.input ?? "Review the attached image.",
          ...(promptImages.length > 0 ? { images: promptImages } : {}),
        })
        .pipe(
          Effect.mapError((cause) => mapRequestError("prompt", cause)),
          Effect.tapError(() =>
            Effect.sync(() => {
              ctx.activeTurnId = undefined;
            }),
          ),
        );
      return {
        threadId: input.threadId,
        turnId,
        resumeCursor: ctx.session.resumeCursor,
      };
    });

  const interruptTurn: PiAdapterShape["interruptTurn"] = (threadId) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      const turnId = ctx.activeTurnId;
      yield* ctx.rpc
        .request({ type: "abort" })
        .pipe(Effect.mapError((cause) => mapRequestError("abort", cause)));
      for (const pending of ctx.pendingApprovals.values()) {
        yield* ctx.rpc
          .send({
            type: "extension_ui_response",
            id: pending.piRequestId,
            value: PI_APPROVAL_REJECT,
          })
          .pipe(Effect.mapError((cause) => mapRequestError("extension_ui_response", cause)));
      }
      ctx.pendingApprovals.clear();
      ctx.activeTurnId = undefined;
      if (turnId) {
        const updatedAt = yield* nowIso;
        const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
        ctx.session = { ...readySession, status: "ready", updatedAt };
        yield* emit({
          ...(yield* eventBase(ctx, { type: "abort" })),
          type: "turn.aborted",
          turnId,
          payload: { reason: "Interrupted by the user." },
        });
      }
    });

  const respondToRequest: PiAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      const pending = ctx.pendingApprovals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "extension_ui_response",
          detail: `Unknown Pi approval request '${requestId}'.`,
        });
      }
      const value: Record<ProviderApprovalDecision, string> = {
        accept: PI_APPROVAL_ALLOW_ONCE,
        acceptForSession: PI_APPROVAL_ALLOW_SESSION,
        decline: PI_APPROVAL_REJECT,
        cancel: PI_APPROVAL_REJECT,
      };
      yield* ctx.rpc
        .send({ type: "extension_ui_response", id: pending.piRequestId, value: value[decision] })
        .pipe(Effect.mapError((cause) => mapRequestError("extension_ui_response", cause)));
      ctx.pendingApprovals.delete(requestId);
      yield* emit({
        ...(yield* eventBase(ctx, { type: "extension_ui_response", decision })),
        type: "request.resolved",
        requestId: RuntimeRequestId.make(requestId),
        providerRefs: { providerRequestId: pending.piRequestId },
        payload: { requestType: pending.requestType, decision },
      });
    });

  const respondToUserInput: PiAdapterShape["respondToUserInput"] = (threadId, requestId, answers) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      const pending = ctx.pendingUserInputs.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "extension_ui_response",
          detail: `Unknown Pi user-input request '${requestId}'.`,
        });
      }
      const answer = firstAnswer(answers, pending.questionId);
      const response =
        pending.method === "confirm"
          ? { confirmed: answer === true || answer === "Yes" }
          : { value: Array.isArray(answer) ? answer[0] : answer };
      yield* ctx.rpc
        .send({ type: "extension_ui_response", id: pending.piRequestId, ...response })
        .pipe(Effect.mapError((cause) => mapRequestError("extension_ui_response", cause)));
      ctx.pendingUserInputs.delete(requestId);
      yield* emit({
        ...(yield* eventBase(ctx, { type: "extension_ui_response", answers })),
        type: "user-input.resolved",
        requestId: RuntimeRequestId.make(requestId),
        providerRefs: { providerRequestId: pending.piRequestId },
        payload: { answers },
      });
    });

  const readThread: PiAdapterShape["readThread"] = (threadId) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      const data = yield* ctx.rpc
        .request({ type: "get_messages" })
        .pipe(Effect.mapError((cause) => mapRequestError("get_messages", cause)));
      const messages = isRecord(data) && Array.isArray(data.messages) ? data.messages : [];
      const turns = messages.flatMap((message, index) => {
        if (!isRecord(message) || message.role !== "assistant") return [];
        const timestamp = typeof message.timestamp === "number" ? message.timestamp : index;
        return [{ id: TurnId.make(`pi-${timestamp}-${index}`), items: [message] }];
      });
      return { threadId, turns } satisfies ProviderThreadSnapshot;
    });

  const rollbackThread: PiAdapterShape["rollbackThread"] = (threadId, numTurns) =>
    Effect.gen(function* () {
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        });
      }
      const ctx = yield* requireSession(threadId);
      const data = yield* ctx.rpc
        .request({ type: "get_fork_messages" })
        .pipe(Effect.mapError((cause) => mapRequestError("get_fork_messages", cause)));
      const messages = isRecord(data) && Array.isArray(data.messages) ? data.messages : [];
      const target = messages[messages.length - numTurns];
      const entryId = isRecord(target) ? readString(target, "entryId") : undefined;
      if (!entryId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: `Cannot roll back ${numTurns} turn(s).`,
        });
      }
      yield* ctx.rpc
        .request({ type: "fork", entryId })
        .pipe(Effect.mapError((cause) => mapRequestError("fork", cause)));
      return yield* readThread(threadId);
    });

  const stopSession: PiAdapterShape["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const ctx = yield* requireSession(threadId);
      yield* stopContext(ctx);
      yield* emit({
        ...(yield* eventBase(ctx, { type: "stop" })),
        type: "session.exited",
        payload: { reason: "Session stopped.", recoverable: true, exitKind: "graceful" },
      });
    });

  const stopAll = () =>
    Effect.forEach([...sessions.values()], stopContext, { discard: true }).pipe(Effect.asVoid);
  yield* Scope.addFinalizer(adapterScope, stopAll());

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions: () => Effect.sync(() => [...sessions.values()].map((ctx) => ctx.session)),
    hasSession: (threadId: ThreadId) => Effect.sync(() => sessions.has(threadId)),
    readThread,
    rollbackThread,
    stopAll,
    streamEvents: Stream.fromPubSub(events),
  } satisfies PiAdapterShape;
});
