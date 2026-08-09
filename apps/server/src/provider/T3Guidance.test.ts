import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import { describe } from "vite-plus/test";

import { buildT3Guidance } from "./T3Guidance.ts";

describe("buildT3Guidance", () => {
  it("always states the T3 runtime context", () => {
    const guidance = buildT3Guidance({ hasPreviewTools: false });
    NodeAssert.match(guidance, /operating inside T3 Code/);
  });

  it("omits preview guidance when no preview tools are attached", () => {
    const guidance = buildT3Guidance({ hasPreviewTools: false });
    NodeAssert.doesNotMatch(guidance, /preview_/);
  });

  it("includes collaborative-browser guidance only when preview tools are attached", () => {
    const guidance = buildT3Guidance({ hasPreviewTools: true });
    NodeAssert.match(guidance, /preview_status/);
    NodeAssert.match(guidance, /preview_open/);
    NodeAssert.match(guidance, /Do not switch to global browser skills/);
    NodeAssert.match(guidance, /T3 Code runtime/);
  });

  it("stays provider-neutral so every delivery channel (including ACP) is safe", () => {
    const guidance = buildT3Guidance({ hasPreviewTools: true });
    for (const codexProtocolToken of [
      "request_user_input",
      "update_plan",
      "<proposed_plan>",
      "<collaboration_mode>",
      "collaboration_mode",
    ]) {
      NodeAssert.doesNotMatch(
        guidance,
        new RegExp(codexProtocolToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
    }
  });
});
