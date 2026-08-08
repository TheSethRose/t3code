import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { makePiAdapter } from "./PiAdapter.ts";

const layer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-adapter-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer)("PiAdapter", (it) => {
  it.effect("starts a session and maps a Pi prompt to canonical runtime events", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pi-rpc-mock-" });
      const executable = path.join(directory, "pi-mock.mjs");
      yield* fileSystem.writeFileString(
        executable,
        `#!/usr/bin/env node
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  const respond = (data) => process.stdout.write(JSON.stringify({
    type: "response",
    id: request.id,
    command: request.type,
    success: true,
    ...(data === undefined ? {} : { data }),
  }) + "\\n");
  if (request.type === "get_state") {
    respond({ sessionId: "pi-session-1" });
  } else if (request.type === "prompt") {
    respond();
    process.stdout.write(JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello from Pi" },
    }) + "\\n");
    process.stdout.write('{"type":"agent_settled"}\\n');
  } else if (request.type === "get_session_stats") {
    respond({ tokens: { input: 4, output: 3, total: 7 } });
  } else {
    respond();
  }
}
`,
      );
      yield* fileSystem.chmod(executable, 0o755);

      const adapter = yield* makePiAdapter(
        { binaryPath: executable, launchArgs: "" },
        { instanceId: ProviderInstanceId.make("pi_test"), environment: process.env },
      );
      const threadId = ThreadId.make("pi-thread");
      const events: ProviderRuntimeEvent[] = [];
      const completed = yield* Deferred.make<void>();
      const eventFiber = yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => events.push(event)).pipe(
            Effect.andThen(
              event.type === "turn.completed"
                ? Deferred.succeed(completed, undefined)
                : Effect.void,
            ),
          ),
        ),
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("pi"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "pi-session-1",
      });

      yield* adapter.sendTurn({ threadId, input: "hello" });
      yield* Deferred.await(completed);
      yield* Fiber.interrupt(eventFiber);

      assert.includeMembers(
        events.map((event) => event.type),
        ["session.started", "turn.started", "content.delta", "turn.completed"],
      );
      const delta = events.find((event) => event.type === "content.delta");
      assert.equal(
        delta?.type === "content.delta" ? delta.payload.delta : undefined,
        "hello from Pi",
      );
      yield* adapter.stopSession(threadId);
    }),
  );
});
