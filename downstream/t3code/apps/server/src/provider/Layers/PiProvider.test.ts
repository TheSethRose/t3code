import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { PiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { checkPiProviderStatus } from "./PiProvider.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);

describe("checkPiProviderStatus", () => {
  it.effect("reports a missing Pi executable", () =>
    checkPiProviderStatus(
      decodePiSettings({ binaryPath: "/definitely/not/installed/pi" }),
      true,
    ).pipe(
      Effect.provide(NodeServices.layer),
      Effect.map((snapshot) => {
        expect(snapshot.installed).toBe(false);
        expect(snapshot.status).toBe("error");
      }),
    ),
  );

  it.effect("discovers Pi models and thinking levels over RPC", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pi-provider-" });
      const executable = path.join(directory, "pi");
      yield* fileSystem.writeFileString(
        executable,
        `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'pi 0.83.0\\n'
  exit 0
fi
while IFS= read -r request; do
  case "$request" in
    *get_available_models*) printf '%s\\n' '{"type":"response","id":"t3-1","command":"get_available_models","success":true,"data":{"models":[{"provider":"openrouter","id":"demo","name":"Demo","reasoning":true}]}}' ;;
    *get_state*) printf '%s\\n' '{"type":"response","id":"t3-2","command":"get_state","success":true,"data":{"model":{"provider":"openrouter","id":"demo"},"thinkingLevel":"high"}}' ;;
    *get_commands*) printf '%s\\n' '{"type":"response","id":"t3-3","command":"get_commands","success":true,"data":{"commands":[{"name":"skill:review-code","description":"Review code carefully.","source":"skill","sourceInfo":{"path":"/Users/test/.agents/skills/review-code/SKILL.md","scope":"user","source":"auto","origin":"top-level"}},{"name":"stats","source":"extension","sourceInfo":{"path":"/tmp/stats.ts","scope":"user","source":"auto","origin":"top-level"}}]}}' ;;
    *set_model*) printf '%s\\n' '{"type":"response","id":"t3-4","command":"set_model","success":true}' ;;
    *get_available_thinking_levels*) printf '%s\\n' '{"type":"response","id":"t3-5","command":"get_available_thinking_levels","success":true,"data":{"levels":["off","high","xhigh"]}}' ;;
  esac
done
`,
      );
      yield* fileSystem.chmod(executable, 0o755);

      const snapshot = yield* checkPiProviderStatus(
        decodePiSettings({ binaryPath: executable }),
        true,
      );
      expect(snapshot.version).toBe("0.83.0");
      expect(snapshot.status).toBe("ready");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["openrouter/demo"]);
      expect(snapshot.models[0]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
        id: "thinkingLevel",
        currentValue: "high",
      });
      expect(snapshot.skills).toEqual([
        {
          name: "review-code",
          description: "Review code carefully.",
          path: "/Users/test/.agents/skills/review-code/SKILL.md",
          scope: "user",
          enabled: true,
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe.runIf(process.env.T3_PI_CLI_PROBE === "1")("real Pi CLI", () => {
  it.effect("reports the installed authenticated model catalog", () =>
    checkPiProviderStatus(decodePiSettings({}), true).pipe(
      Effect.provide(NodeServices.layer),
      Effect.map((snapshot) => {
        expect(snapshot.installed).toBe(true);
        expect(snapshot.status).toBe("ready");
        expect(snapshot.auth.status).toBe("authenticated");
        expect(snapshot.models.length).toBeGreaterThan(0);
        expect(snapshot.skills.length).toBeGreaterThan(0);
      }),
    ),
  );
});
