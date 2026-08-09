import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { makeHermesAcpRuntimePool, resolveHermesAcpArgs } from "../acp/HermesAcpRuntime.ts";
import { makeHermesAdapter } from "./HermesAdapter.ts";

const mockPeerPath = new URL("./fixtures/hermes-adapter-mock-peer.ts", import.meta.url).pathname;
const mockHermesPath = new URL("./fixtures/hermes-adapter-mock", import.meta.url).pathname;

it("always scopes the ACP child to the selected Hermes profile", () => {
  assert.deepEqual(
    resolveHermesAcpArgs(
      {
        enabled: true,
        binaryPath: "hermes",
        launchArgs: "acp --accept-hooks",
        authMethodId: "",
      },
      "work",
    ),
    ["-p", "work", "acp", "--accept-hooks"],
  );
});

it.layer(NodeServices.layer)("HermesAdapter", (it) => {
  it.effect("maps Hermes permission scopes and settles repeated and interrupted turns", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("hermes_test");
      const runtimes = yield* makeHermesAcpRuntimePool({
        enabled: true,
        binaryPath: mockHermesPath,
        launchArgs: mockPeerPath,
        authMethodId: "",
      });
      const adapter = yield* makeHermesAdapter(runtimes, {
        instanceId,
        skills: [
          { profile: "default", names: ["alpha"] },
          { profile: "x_agent", names: ["x-only"] },
        ],
      });
      const threadId = ThreadId.make("acp-thread");
      const events: ProviderRuntimeEvent[] = [];
      const holding = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const eventFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => events.push(event)).pipe(
            Effect.andThen(
              event.type === "request.opened"
                ? adapter.respondToRequest(
                    threadId,
                    ApprovalRequestId.make(event.requestId!),
                    "acceptForSession",
                  )
                : Effect.void,
            ),
            Effect.andThen(
              event.type === "content.delta" && event.payload.delta === "hold"
                ? Deferred.succeed(holding, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ),
            Effect.andThen(
              event.type === "turn.completed" && event.payload.state === "cancelled"
                ? Deferred.succeed(cancelled, undefined).pipe(Effect.asVoid)
                : Effect.void,
            ),
          ),
        ),
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("hermes"),
        providerInstanceId: instanceId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId, model: "hermes/default" },
      });
      assert.equal(session.providerInstanceId, instanceId);

      const permissionTurn = yield* adapter.sendTurn({ threadId, input: "permission" });
      const nextTurn = yield* adapter.sendTurn({ threadId, input: "next" });
      assert.notEqual(permissionTurn.turnId, nextTurn.turnId);
      assert.isTrue(
        events.some((event) => event.type === "content.delta" && event.payload.delta === "next"),
      );
      yield* adapter.sendTurn({ threadId, input: "shape" });
      assert.isTrue(
        events.some(
          (event) => event.type === "content.delta" && event.payload.delta === "prompt,sessionId",
        ),
      );

      const secondThreadId = ThreadId.make("hermes-thread-2");
      yield* adapter.startSession({
        threadId: secondThreadId,
        provider: ProviderDriverKind.make("hermes"),
        providerInstanceId: instanceId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId, model: "hermes/default" },
      });
      yield* Effect.all(
        [
          adapter.sendTurn({ threadId, input: "process" }),
          adapter.sendTurn({ threadId: secondThreadId, input: "process" }),
        ],
        { concurrency: "unbounded" },
      );
      const processIds = events.flatMap((event) =>
        event.type === "content.delta" && /^\d+$/.test(event.payload.delta)
          ? [event.payload.delta]
          : [],
      );
      assert.equal(processIds.length, 2);
      assert.equal(new Set(processIds).size, 1);

      const thirdThreadId = ThreadId.make("hermes-thread-3");
      yield* adapter.startSession({
        threadId: thirdThreadId,
        provider: ProviderDriverKind.make("hermes"),
        providerInstanceId: instanceId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId, model: "hermes/x_agent" },
      });
      yield* adapter.sendTurn({ threadId: thirdThreadId, input: "process" });
      const allProcessIds = events.flatMap((event) =>
        event.type === "content.delta" && /^\d+$/.test(event.payload.delta)
          ? [event.payload.delta]
          : [],
      );
      assert.equal(allProcessIds.length, 3);
      assert.notEqual(allProcessIds[0], allProcessIds[2]);

      yield* adapter.sendTurn({ threadId, input: "$alpha inspect" });
      assert.ok(
        events.some(
          (event) =>
            event.type === "content.delta" &&
            event.payload.delta.includes("call skill_view") &&
            event.payload.delta.endsWith("$alpha inspect"),
        ),
      );

      const heldTurn = yield* adapter.sendTurn({ threadId, input: "hold" }).pipe(Effect.forkChild);
      yield* Deferred.await(holding);
      yield* adapter.interruptTurn(threadId).pipe(Effect.timeout("2 seconds"));
      yield* Fiber.join(heldTurn).pipe(Effect.timeout("2 seconds"));
      yield* Deferred.await(cancelled);
      yield* Fiber.interrupt(eventFiber);

      assert.ok(
        events.some(
          (event) =>
            event.type === "content.delta" &&
            event.payload.delta === "auth:test-provider;selected:allow_session",
        ),
      );
      assert.equal(events.filter((event) => event.type === "turn.started").length, 8);
      assert.equal(events.filter((event) => event.type === "turn.completed").length, 8);
      assert.ok(events.every((event) => event.providerInstanceId === instanceId));
      assert.ok(
        events.some(
          (event) => event.type === "turn.completed" && event.payload.state === "cancelled",
        ),
      );
      yield* adapter.stopSession(threadId);
      yield* adapter.stopSession(secondThreadId);
      yield* adapter.stopSession(thirdThreadId);
    }),
  );
});
