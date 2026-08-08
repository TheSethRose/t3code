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

import { makeAcpAdapter } from "./AcpAdapter.ts";

const mockPeerPath = new URL("./fixtures/acp-adapter-mock-peer.ts", import.meta.url).pathname;

it.layer(NodeServices.layer)("AcpAdapter", (it) => {
  it.effect("maps Hermes permission scopes and settles repeated and interrupted turns", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("acp_test");
      const adapter = yield* makeAcpAdapter(
        {
          enabled: true,
          binaryPath: process.execPath,
          launchArgs: mockPeerPath,
          authMethodId: "",
          customModels: [],
        },
        { instanceId, environment: process.env },
      );
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
        provider: ProviderDriverKind.make("acp"),
        providerInstanceId: instanceId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      assert.equal(session.providerInstanceId, instanceId);

      const permissionTurn = yield* adapter.sendTurn({ threadId, input: "permission" });
      const nextTurn = yield* adapter.sendTurn({ threadId, input: "next" });
      assert.notEqual(permissionTurn.turnId, nextTurn.turnId);

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
      assert.equal(events.filter((event) => event.type === "turn.started").length, 3);
      assert.equal(events.filter((event) => event.type === "turn.completed").length, 3);
      assert.ok(events.every((event) => event.providerInstanceId === instanceId));
      assert.ok(
        events.some(
          (event) => event.type === "turn.completed" && event.payload.state === "cancelled",
        ),
      );
      yield* adapter.stopSession(threadId);
    }),
  );
});
