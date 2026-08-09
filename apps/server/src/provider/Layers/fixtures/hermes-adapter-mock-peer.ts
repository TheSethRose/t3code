import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AcpAgent from "effect-acp/agent";

const program = Effect.gen(function* () {
  const agent = yield* AcpAgent.AcpAgent;
  const cancellations = new Map<string, Deferred.Deferred<void>>();
  let nextSession = 0;
  let authenticatedMethodId = "";

  yield* agent.handleInitialize(() =>
    Effect.succeed({
      protocolVersion: 1,
      agentCapabilities: {},
      agentInfo: { name: "hermes-adapter-test", version: "0.0.0" },
      authMethods: [
        { id: "test-provider", name: "Test provider" },
        { id: "setup", name: "Setup", type: "terminal", args: ["--setup"] },
      ],
    }),
  );
  yield* agent.handleAuthenticate((request) =>
    Effect.sync(() => {
      authenticatedMethodId = request.methodId;
      return {};
    }),
  );
  yield* agent.handleCreateSession(() =>
    Effect.gen(function* () {
      const sessionId = `hermes-test-session-${++nextSession}`;
      cancellations.set(sessionId, yield* Deferred.make<void>());
      return {
        sessionId,
        models: {
          currentModelId: "provider:model-one",
          availableModels: [
            { modelId: "provider:model-one", name: "Model One" },
            { modelId: "provider:model-two", name: "Model Two" },
          ],
        },
      };
    }),
  );
  yield* agent.handleSetSessionModel(() => Effect.succeed({}));
  yield* agent.handleCancel((request) =>
    cancellations.get(request.sessionId)
      ? Deferred.succeed(cancellations.get(request.sessionId)!, undefined).pipe(Effect.asVoid)
      : Effect.void,
  );
  yield* agent.handlePrompt((request) =>
    Effect.gen(function* () {
      const text = request.prompt
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("");

      if (text === "permission") {
        const response = yield* agent.client.requestPermission({
          sessionId: request.sessionId,
          toolCall: { toolCallId: "permission-1", title: "Run a safe test command" },
          options: [
            { optionId: "allow_always", name: "Allow always", kind: "allow_always" },
            { optionId: "allow_session", name: "Allow for session", kind: "allow_always" },
            { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        });
        yield* agent.client.sessionUpdate({
          sessionId: request.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text:
                response.outcome.outcome === "selected"
                  ? `auth:${authenticatedMethodId};selected:${response.outcome.optionId}`
                  : "cancelled",
            },
          },
        });
        return { stopReason: "end_turn" as const };
      }

      yield* agent.client.sessionUpdate({
        sessionId: request.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: text === "process" ? String(process.pid) : text },
        },
      });
      if (text === "hold") {
        yield* Deferred.await(cancellations.get(request.sessionId)!);
        return { stopReason: "cancelled" as const };
      }
      return { stopReason: "end_turn" as const };
    }),
  );

  return yield* Effect.never;
});

program.pipe(
  Effect.provide(Layer.provide(AcpAgent.layerStdio(), NodeServices.layer)),
  NodeRuntime.runMain,
);
