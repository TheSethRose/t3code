import type { HermesSettings } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as AcpClient from "effect-acp/client";
import * as AcpErrors from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/schema";

import { resolveAcpAuthMethodId } from "./AcpSessionRuntime.ts";

export interface HermesAcpSession {
  readonly sessionId: string;
  readonly setup:
    | AcpSchema.LoadSessionResponse
    | AcpSchema.NewSessionResponse
    | AcpSchema.ResumeSessionResponse;
}

export interface HermesAcpRuntime {
  readonly createSession: (input: {
    readonly cwd: string;
    readonly resumeSessionId?: string;
    readonly mcpServers?: ReadonlyArray<AcpSchema.McpServer>;
  }) => Effect.Effect<HermesAcpSession, AcpErrors.AcpError>;
  readonly prompt: (
    sessionId: string,
    payload: Omit<AcpSchema.PromptRequest, "sessionId">,
  ) => Effect.Effect<AcpSchema.PromptResponse, AcpErrors.AcpError>;
  readonly cancel: (sessionId: string) => Effect.Effect<void, AcpErrors.AcpError>;
  readonly handleSessionUpdate: (
    handler: (notification: AcpSchema.SessionNotification) => Effect.Effect<void>,
  ) => Effect.Effect<() => void>;
  readonly handleRequestPermission: (
    handler: (
      request: AcpSchema.RequestPermissionRequest,
    ) => Effect.Effect<AcpSchema.RequestPermissionResponse, AcpErrors.AcpError>,
  ) => Effect.Effect<void>;
}

interface Connection {
  readonly generation: number;
  readonly scope: Scope.Closeable;
  readonly client: AcpClient.AcpClient["Service"];
}

type ConnectionState =
  | { readonly _tag: "idle"; readonly generation: number }
  | {
      readonly _tag: "starting";
      readonly generation: number;
      readonly deferred: Deferred.Deferred<Connection, AcpErrors.AcpError>;
    }
  | { readonly _tag: "ready"; readonly connection: Connection };

function parseLaunchArgs(raw: string): ReadonlyArray<string> {
  const args = raw.trim().split(/\s+/).filter(Boolean);
  return args.length > 0 ? args : ["acp"];
}

export function resolveHermesAcpArgs(settings: HermesSettings): ReadonlyArray<string> {
  const profile = settings.profile.trim() || "default";
  return ["-p", profile, ...parseLaunchArgs(settings.launchArgs)];
}

function isFatalConnectionError(error: AcpErrors.AcpError): boolean {
  return error._tag !== "AcpRequestError";
}

export const makeHermesAcpRuntime = Effect.fn("makeHermesAcpRuntime")(function* (
  settings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  HermesAcpRuntime,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const parentScope = yield* Scope.Scope;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const stateRef = yield* Ref.make<ConnectionState>({ _tag: "idle", generation: 0 });
  const sessionUpdateHandlers = new Set<
    (notification: AcpSchema.SessionNotification) => Effect.Effect<void>
  >();
  let permissionHandler:
    | ((
        request: AcpSchema.RequestPermissionRequest,
      ) => Effect.Effect<AcpSchema.RequestPermissionResponse, AcpErrors.AcpError>)
    | undefined;

  const closeConnection = (connection: Connection) =>
    Scope.close(connection.scope, Exit.void).pipe(Effect.ignore);

  const invalidate = (connection: Connection) =>
    Ref.modify(stateRef, (state) => {
      if (state._tag !== "ready" || state.connection.generation !== connection.generation) {
        return [Effect.void, state] as const;
      }
      return [
        closeConnection(connection),
        { _tag: "idle", generation: connection.generation } satisfies ConnectionState,
      ] as const;
    }).pipe(Effect.flatten);

  const openConnection = Effect.fn("HermesAcpRuntime.openConnection")(function* (
    generation: number,
  ): Effect.fn.Return<Connection, AcpErrors.AcpError> {
    const childScope = yield* Scope.make("sequential");
    return yield* Effect.gen(function* () {
      const command = settings.binaryPath || "hermes";
      const args = resolveHermesAcpArgs(settings);
      const spawnCommand = yield* resolveSpawnCommand(command, args, {
        env: environment,
        extendEnv: true,
      });
      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            env: environment,
            extendEnv: true,
            shell: spawnCommand.shell,
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, childScope),
          Effect.mapError((cause) => new AcpErrors.AcpSpawnError({ command, cause })),
        );
      const clientContext = yield* Layer.build(AcpClient.layerChildProcess(child)).pipe(
        Effect.provideService(Scope.Scope, childScope),
      );
      const client = yield* Effect.service(AcpClient.AcpClient).pipe(Effect.provide(clientContext));

      yield* client.handleSessionUpdate((notification) =>
        Effect.forEach(sessionUpdateHandlers, (handler) => handler(notification), {
          discard: true,
        }),
      );
      yield* client.handleRequestPermission((request) =>
        permissionHandler
          ? permissionHandler(request)
          : Effect.succeed({ outcome: { outcome: "cancelled" as const } }),
      );

      const initialized = yield* client.agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "t3-code-hermes", version: "0.0.0" },
      });
      yield* client.agent.authenticate({
        methodId: resolveAcpAuthMethodId(settings.authMethodId, initialized),
      });

      return { generation, scope: childScope, client };
    }).pipe(Effect.onError(() => Scope.close(childScope, Exit.void).pipe(Effect.ignore)));
  });

  const connection = Effect.fn("HermesAcpRuntime.connection")(function* () {
    const deferred = yield* Deferred.make<Connection, AcpErrors.AcpError>();
    const acquire = yield* Ref.modify(stateRef, (state) => {
      if (state._tag === "ready") return [Effect.succeed(state.connection), state] as const;
      if (state._tag === "starting") return [Deferred.await(state.deferred), state] as const;
      const generation = state.generation + 1;
      return [
        openConnection(generation).pipe(
          Effect.tap((opened) =>
            Ref.set(stateRef, { _tag: "ready", connection: opened }).pipe(
              Effect.andThen(Deferred.succeed(deferred, opened)),
            ),
          ),
          Effect.onError((cause) =>
            Deferred.failCause(deferred, cause).pipe(
              Effect.andThen(Ref.set(stateRef, { _tag: "idle", generation })),
            ),
          ),
        ),
        { _tag: "starting", generation, deferred } satisfies ConnectionState,
      ] as const;
    });
    return yield* acquire;
  });

  const useConnection = <A>(
    operation: (connection: Connection) => Effect.Effect<A, AcpErrors.AcpError>,
  ): Effect.Effect<A, AcpErrors.AcpError> =>
    connection().pipe(
      Effect.flatMap((active) =>
        operation(active).pipe(
          Effect.tapError((error) =>
            isFatalConnectionError(error) ? invalidate(active) : Effect.void,
          ),
        ),
      ),
    );

  yield* Scope.addFinalizer(
    parentScope,
    Ref.get(stateRef).pipe(
      Effect.flatMap((state) =>
        state._tag === "ready" ? closeConnection(state.connection) : Effect.void,
      ),
    ),
  );

  return {
    createSession: ({ cwd, resumeSessionId, mcpServers }) =>
      useConnection((active) => {
        if (resumeSessionId) {
          return active.client.agent
            .loadSession({ sessionId: resumeSessionId, cwd, mcpServers: mcpServers ?? [] })
            .pipe(
              Effect.map((setup) => ({ sessionId: resumeSessionId, setup })),
              Effect.catch((error) =>
                error._tag === "AcpRequestError"
                  ? active.client.agent
                      .createSession({ cwd, mcpServers: mcpServers ?? [] })
                      .pipe(Effect.map((setup) => ({ sessionId: setup.sessionId, setup })))
                  : Effect.fail(error),
              ),
            );
        }
        return active.client.agent
          .createSession({ cwd, mcpServers: mcpServers ?? [] })
          .pipe(Effect.map((setup) => ({ sessionId: setup.sessionId, setup })));
      }),
    prompt: (sessionId, payload) =>
      useConnection((active) => active.client.agent.prompt({ sessionId, ...payload })),
    cancel: (sessionId) => useConnection((active) => active.client.agent.cancel({ sessionId })),
    handleSessionUpdate: (handler) =>
      Effect.sync(() => {
        sessionUpdateHandlers.add(handler);
        return () => sessionUpdateHandlers.delete(handler);
      }),
    handleRequestPermission: (handler) =>
      Effect.sync(() => {
        permissionHandler = handler;
      }),
  };
});
