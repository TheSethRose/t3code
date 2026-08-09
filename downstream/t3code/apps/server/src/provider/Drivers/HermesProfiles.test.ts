import { expect, it } from "vite-plus/test";

import { hermesProfileFromModel, parseHermesProfileList } from "./HermesProfiles.ts";

it("parses every Hermes profile and preserves the active default", () => {
  expect(
    parseHermesProfileList(`
 Profile          Model                        Gateway
 ───────────────  ───────────────────────────  ───────────
 ◆default         deepseek-v4-flash            running
  delegated-agent openai/gpt-5.6-terra         stopped
  x_agent         gpt-5.6-sol                  running`),
  ).toEqual([
    { name: "default", isDefault: true },
    { name: "delegated-agent", isDefault: false },
    { name: "x_agent", isDefault: false },
  ]);
});

it("accepts only Hermes profile model slugs", () => {
  expect(hermesProfileFromModel("hermes/x_agent")).toBe("x_agent");
  expect(hermesProfileFromModel("hermes/not/a/profile")).toBeUndefined();
  expect(hermesProfileFromModel("gpt-5")).toBeUndefined();
});
