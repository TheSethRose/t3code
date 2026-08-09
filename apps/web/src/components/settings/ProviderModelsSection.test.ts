import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ServerProviderModel } from "@t3tools/contracts";

import { filterProviderModelsForDisplay } from "./ProviderModelsSection";

const models: ReadonlyArray<ServerProviderModel> = [
  { slug: "openai/gpt-5", name: "GPT-5", isCustom: false, capabilities: null },
  { slug: "google/gemini", name: "Gemini", isCustom: false, capabilities: null },
];

describe("filterProviderModelsForDisplay", () => {
  it("contains-matches ACP model names and slugs case-insensitively", () => {
    expect(
      filterProviderModelsForDisplay({
        driverKind: ProviderDriverKind.make("acp"),
        models,
        query: "OPENAI",
      }).map((model) => model.slug),
    ).toEqual(["openai/gpt-5"]);
  });
});
