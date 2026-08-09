import type { HermesSettings } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import { ChildProcess } from "effect/unstable/process";

import { spawnAndCollect } from "../providerSnapshot.ts";

export interface HermesProfile {
  readonly name: string;
  readonly isDefault: boolean;
}

const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

export function parseHermesProfileList(output: string): ReadonlyArray<HermesProfile> {
  const profiles = new Map<string, HermesProfile>();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*([◆*])?\s*([a-z0-9][a-z0-9_-]{0,63})(?:\s+|$)/u.exec(line);
    const name = match?.[2];
    if (!name || !PROFILE_NAME.test(name) || name === "profile") continue;
    profiles.set(name, { name, isDefault: match?.[1] !== undefined });
  }
  if (![...profiles.values()].some((profile) => profile.isDefault) && profiles.has("default")) {
    profiles.set("default", { name: "default", isDefault: true });
  }
  return [...profiles.values()];
}

export function hermesProfileFromModel(model: string | undefined): string | undefined {
  const profile = model?.startsWith("hermes/") ? model.slice("hermes/".length) : undefined;
  return profile && PROFILE_NAME.test(profile) ? profile : undefined;
}

export const discoverHermesProfiles = Effect.fn("discoverHermesProfiles")(function* (
  settings: Pick<HermesSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const binary = settings.binaryPath || "hermes";
  const command = yield* resolveSpawnCommand(binary, ["profile", "list"], { env: environment });
  const result = yield* spawnAndCollect(
    binary,
    ChildProcess.make(command.command, command.args, {
      env: { ...environment, COLUMNS: "10000", NO_COLOR: "1", TERM: "dumb" },
      shell: command.shell,
    }),
  );
  return result.code === 0 ? parseHermesProfileList(`${result.stdout}\n${result.stderr}`) : [];
});
