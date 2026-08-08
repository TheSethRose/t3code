import { type ModelSelection, type PiSettings, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makePiRpcClient, PiRpcError, resolvePiLaunchArgs } from "../provider/pi/PiRpcClient.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const PI_TIMEOUT_MS = 180_000;
const isTextGenerationError = Schema.is(TextGenerationError);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function splitModel(slug: string): { readonly provider: string; readonly modelId: string } {
  const separator = slug.indexOf("/");
  if (separator <= 0 || separator === slug.length - 1) {
    throw new PiRpcError({
      operation: "set_model",
      detail: `Expected a Pi model slug in 'provider/model' form, received '${slug}'.`,
    });
  }
  return { provider: slug.slice(0, separator), modelId: slug.slice(separator + 1) };
}

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  settings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runPiJson = <S extends Schema.Top>(input: {
    readonly operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    readonly cwd: string;
    readonly prompt: string;
    readonly outputSchema: S;
    readonly modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const output = yield* Ref.make("");
      const settled = yield* Deferred.make<void, PiRpcError>();
      const rpc = yield* makePiRpcClient({
        binaryPath: settings.binaryPath,
        args: [
          ...resolvePiLaunchArgs(settings.launchArgs),
          "--no-session",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
        ],
        cwd: input.cwd,
        environment,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      yield* rpc.events.pipe(
        Stream.runForEach((value) => {
          if (!isRecord(value)) return Effect.void;
          if (value.type === "agent_settled") return Deferred.succeed(settled, undefined);
          if (value.type !== "message_update" || !isRecord(value.assistantMessageEvent)) {
            return Effect.void;
          }
          const update = value.assistantMessageEvent;
          if (update.type === "text_delta" && typeof update.delta === "string") {
            return Ref.update(output, (current) => current + update.delta);
          }
          if (update.type === "error") {
            return Deferred.fail(
              settled,
              new PiRpcError({
                operation: "prompt",
                detail: typeof update.error === "string" ? update.error : "Pi generation failed.",
              }),
            );
          }
          return Effect.void;
        }),
        Effect.forkScoped,
      );

      yield* rpc.request({ type: "set_model", ...splitModel(input.modelSelection.model) });
      const thinking = getModelSelectionStringOptionValue(input.modelSelection, "thinkingLevel");
      if (thinking) yield* rpc.request({ type: "set_thinking_level", level: thinking });
      yield* rpc.request({ type: "prompt", message: input.prompt });
      yield* Deferred.await(settled).pipe(
        Effect.timeoutOption(PI_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(new PiRpcError({ operation: "prompt", detail: "Pi request timed out." })),
            onSome: () => Effect.void,
          }),
        ),
      );

      const raw = (yield* Ref.get(output)).trim();
      if (!raw) {
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: "Pi returned empty output.",
        });
      }
      return yield* Schema.decodeEffect(Schema.fromJsonString(input.outputSchema))(
        extractJsonObject(raw),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: "Pi returned invalid structured output.",
              cause,
            }),
        ),
      );
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation: input.operation,
              detail: "Pi text generation failed.",
              cause,
            }),
      ),
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("PiTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });
      const generated = yield* runPiJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("PiTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });
      const generated = yield* runPiJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("PiTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });
      const generated = yield* runPiJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return {
        branch: sanitizeFeatureBranchName(sanitizeBranchFragment(generated.branch)),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("PiTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });
      const generated = yield* runPiJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchema,
        modelSelection: input.modelSelection,
      });
      return { title: sanitizeThreadTitle(generated.title) };
    });

  return TextGeneration.TextGeneration.of({
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  });
});
