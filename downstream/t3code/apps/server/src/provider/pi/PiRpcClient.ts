import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const STDERR_LIMIT = 16_000;
const JsonValue = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownSync(JsonValue);
const encodeJson = Schema.encodeSync(JsonValue);
const RESERVED_LAUNCH_FLAGS = new Set([
  "--mode",
  "--extension",
  "-e",
  "--session",
  "--session-id",
  "--fork",
  "--no-session",
]);

export class PiRpcError extends Schema.TaggedErrorClass<PiRpcError>()("PiRpcError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Pi RPC ${this.operation} failed: ${this.detail}`;
  }
}

const isPiRpcError = Schema.is(PiRpcError);

export interface PiRpcClient {
  readonly request: <A = unknown>(
    command: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<A, PiRpcError>;
  readonly send: (command: Readonly<Record<string, unknown>>) => Effect.Effect<void, PiRpcError>;
  readonly events: Stream.Stream<unknown>;
  readonly stderr: Effect.Effect<string>;
  readonly close: Effect.Effect<void>;
}

export interface PiJsonlDecoder {
  readonly write: (chunk: Uint8Array) => ReadonlyArray<string>;
  readonly end: () => ReadonlyArray<string>;
}

export function makePiJsonlDecoder(): PiJsonlDecoder {
  const decoder = new TextDecoder();
  let buffer = "";

  const drain = (final: boolean): ReadonlyArray<string> => {
    const lines: string[] = [];
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const raw = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      lines.push(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
      newline = buffer.indexOf("\n");
    }
    if (final && buffer.length > 0) {
      lines.push(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
      buffer = "";
    }
    return lines.filter((line) => line.length > 0);
  };

  return {
    write: (chunk) => {
      buffer += decoder.decode(chunk, { stream: true });
      return drain(false);
    },
    end: () => {
      buffer += decoder.decode();
      return drain(true);
    },
  };
}

export function resolvePiLaunchArgs(launchArgs: string | undefined): ReadonlyArray<string> {
  const tokens = tokenizeCliArgs(launchArgs);
  for (const token of tokens) {
    const flag = token.split("=", 1)[0];
    if (flag && RESERVED_LAUNCH_FLAGS.has(flag)) {
      throw new PiRpcError({
        operation: "configuration",
        detail: `Launch argument '${flag}' is managed by T3 Code.`,
      });
    }
  }
  return tokens;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const makePiRpcClient = Effect.fn("makePiRpcClient")(function* (input: {
  readonly binaryPath: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly environment?: NodeJS.ProcessEnv;
}): Effect.fn.Return<
  PiRpcClient,
  PiRpcError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const scope = yield* Scope.Scope;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = yield* resolveSpawnCommand(input.binaryPath, ["--mode", "rpc", ...input.args], {
    env: input.environment ?? process.env,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new PiRpcError({
          operation: "spawn",
          detail: `Could not resolve '${input.binaryPath}'.`,
          cause,
        }),
    ),
  );
  const child = yield* spawner
    .spawn(
      ChildProcess.make(command.command, command.args, {
        ...(input.cwd ? { cwd: input.cwd } : {}),
        env: input.environment ?? process.env,
        shell: command.shell,
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new PiRpcError({
            operation: "spawn",
            detail: `Could not start '${input.binaryPath}'.`,
            cause,
          }),
      ),
    );

  const inputQueue = yield* Queue.unbounded<string>();
  const eventPubSub = yield* PubSub.unbounded<unknown>();
  const stderrRef = yield* Ref.make("");
  const pending = new Map<string, Deferred.Deferred<unknown, PiRpcError>>();
  let requestSequence = 0;
  let closed = false;

  const failPending = (error: PiRpcError) =>
    Effect.gen(function* () {
      const requests = [...pending.values()];
      pending.clear();
      yield* Effect.forEach(requests, (deferred) => Deferred.fail(deferred, error), {
        discard: true,
      });
    });

  const send: PiRpcClient["send"] = (value) =>
    Effect.gen(function* () {
      if (closed) {
        return yield* new PiRpcError({
          operation: "write",
          detail: "The Pi process is closed.",
        });
      }
      const accepted = yield* Queue.offer(inputQueue, `${encodeJson(value)}\n`);
      if (!accepted) {
        return yield* new PiRpcError({ operation: "write", detail: "Pi stdin is closed." });
      }
    });

  const handleLine = (line: string) =>
    Effect.gen(function* () {
      const value = yield* Effect.try({
        try: () => decodeJson(line),
        catch: (cause) =>
          new PiRpcError({
            operation: "decode",
            detail: "Pi emitted invalid JSON.",
            cause,
          }),
      });
      if (isRecord(value) && value.type === "response" && typeof value.id === "string") {
        const deferred = pending.get(value.id);
        if (!deferred) return;
        pending.delete(value.id);
        if (value.success === false) {
          yield* Deferred.fail(
            deferred,
            new PiRpcError({
              operation: typeof value.command === "string" ? value.command : "request",
              detail: typeof value.error === "string" ? value.error : "Pi rejected the request.",
            }),
          );
          return;
        }
        yield* Deferred.succeed(deferred, value.data);
        return;
      }
      yield* PubSub.publish(eventPubSub, value);
    });

  const decoder = makePiJsonlDecoder();
  const stdoutLoop = child.stdout.pipe(
    Stream.runForEach((chunk) =>
      Effect.forEach(decoder.write(chunk), handleLine, { discard: true }),
    ),
    Effect.andThen(
      Effect.suspend(() => Effect.forEach(decoder.end(), handleLine, { discard: true })),
    ),
    Effect.catch((cause) =>
      failPending(
        isPiRpcError(cause)
          ? cause
          : new PiRpcError({ operation: "read", detail: "Pi stdout failed.", cause }),
      ),
    ),
  );
  yield* Effect.forkIn(stdoutLoop, scope);

  const stderrLoop = child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Ref.update(stderrRef, (current) => `${current}${chunk}`.slice(-STDERR_LIMIT)),
    ),
    Effect.ignore,
  );
  yield* Effect.forkIn(stderrLoop, scope);

  const inputLoop = Stream.run(Stream.encodeText(Stream.fromQueue(inputQueue)), child.stdin).pipe(
    Effect.catch((cause) =>
      failPending(new PiRpcError({ operation: "write", detail: "Pi stdin failed.", cause })),
    ),
  );
  yield* Effect.forkIn(inputLoop, scope);

  const exitLoop = child.exitCode.pipe(
    Effect.flatMap((code) =>
      Ref.get(stderrRef).pipe(
        Effect.flatMap((stderr) =>
          failPending(
            new PiRpcError({
              operation: "process",
              detail: `Pi exited with code ${Number(code)}${stderr.trim() ? `: ${stderr.trim()}` : "."}`,
            }),
          ),
        ),
      ),
    ),
    Effect.ignore,
  );
  yield* Effect.forkIn(exitLoop, scope);

  const request: PiRpcClient["request"] = <A>(value: Readonly<Record<string, unknown>>) => {
    const id = `t3-${++requestSequence}`;
    return Effect.gen(function* () {
      const deferred = yield* Deferred.make<unknown, PiRpcError>();
      pending.set(id, deferred);
      yield* send({ ...value, id });
      return (yield* Deferred.await(deferred)) as A;
    }).pipe(Effect.ensuring(Effect.sync(() => pending.delete(id))));
  };

  const close = Effect.gen(function* () {
    if (closed) return;
    closed = true;
    yield* failPending(new PiRpcError({ operation: "process", detail: "Pi was stopped." }));
    yield* Queue.shutdown(inputQueue);
    yield* PubSub.shutdown(eventPubSub);
    const running = yield* child.isRunning.pipe(Effect.orElseSucceed(() => false));
    if (running) {
      yield* child.kill({ killSignal: "SIGTERM", forceKillAfter: "2 seconds" }).pipe(Effect.ignore);
    }
  });
  yield* Scope.addFinalizer(scope, close);

  return {
    request,
    send,
    events: Stream.fromPubSub(eventPubSub),
    stderr: Ref.get(stderrRef),
    close,
  };
});
