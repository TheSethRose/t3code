import type { HermesSettings, ServerProviderSkill } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import { ChildProcess } from "effect/unstable/process";

import { spawnAndCollect } from "../providerSnapshot.ts";

export function parseHermesSkillsList(
  output: string,
  profile: string,
): ReadonlyArray<ServerProviderSkill> {
  const skills = new Map<string, ServerProviderSkill>();
  for (const line of output.split(/\r?\n/)) {
    const name = /^│\s*([^│]+?)\s*│/u.exec(line)?.[1]?.trim();
    if (!name || name === "Name") continue;
    skills.set(name, {
      name,
      path: `hermes://${encodeURIComponent(profile)}/skills/${encodeURIComponent(name)}`,
      scope: `Hermes profile: ${profile}`,
      enabled: true,
    });
  }
  return [...skills.values()].toSorted((left, right) => left.name.localeCompare(right.name));
}

export const discoverHermesSkills = Effect.fn("discoverHermesSkills")(function* (
  settings: Pick<HermesSettings, "binaryPath" | "profile">,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const binary = settings.binaryPath || "hermes";
  const profile = settings.profile.trim() || "default";
  const command = yield* resolveSpawnCommand(
    binary,
    ["-p", profile, "skills", "list", "--enabled-only"],
    { env: environment },
  );
  const result = yield* spawnAndCollect(
    binary,
    ChildProcess.make(command.command, command.args, {
      env: {
        ...environment,
        COLUMNS: "10000",
        NO_COLOR: "1",
        TERM: "dumb",
      },
      shell: command.shell,
    }),
  );
  if (result.code !== 0) return [];
  return parseHermesSkillsList(`${result.stdout}\n${result.stderr}`, profile);
});
