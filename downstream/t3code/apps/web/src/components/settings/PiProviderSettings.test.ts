import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import { deriveProviderSettingsFields } from "./ProviderSettingsForm";
import { DRIVER_OPTION_BY_VALUE, DRIVER_OPTIONS } from "./providerDriverMeta";

describe("Pi provider settings", () => {
  it("is selectable and exposes its CLI configuration", () => {
    const pi = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("pi")];

    expect(DRIVER_OPTIONS).toContain(pi);
    expect(pi?.label).toBe("Pi");
    expect(deriveProviderSettingsFields(pi!).map((field) => field.key)).toEqual([
      "binaryPath",
      "launchArgs",
    ]);
  });
});
