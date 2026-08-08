import { describe, expect, it } from "@effect/vitest";

import {
  PI_APPROVAL_ALLOW_ONCE,
  PI_APPROVAL_ALLOW_SESSION,
  PI_APPROVAL_EXTENSION_SOURCE,
  PI_APPROVAL_REJECT,
} from "./PiApprovalExtension.ts";

type ToolCallHandler = (
  event: { toolName: string; input: unknown },
  context: { ui: { select: () => Promise<string | undefined> } },
) => Promise<{ block: true; reason: string } | undefined>;

async function loadHandler(): Promise<ToolCallHandler> {
  let handler: ToolCallHandler | undefined;
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(PI_APPROVAL_EXTENSION_SOURCE).toString("base64")}`
  );
  module.default({
    on: (_event: string, nextHandler: ToolCallHandler) => {
      handler = nextHandler;
    },
  });
  if (!handler) throw new Error("Pi approval extension did not register tool_call.");
  return handler;
}

describe("Pi approval extension", () => {
  it("blocks rejected tools and remembers session approval by tool name", async () => {
    const handler = await loadHandler();
    const event = { toolName: "bash", input: { command: "pwd" } };

    await expect(
      handler(event, { ui: { select: async () => PI_APPROVAL_REJECT } }),
    ).resolves.toMatchObject({ block: true });
    await expect(
      handler(event, { ui: { select: async () => PI_APPROVAL_ALLOW_ONCE } }),
    ).resolves.toBeUndefined();
    await expect(
      handler(event, { ui: { select: async () => PI_APPROVAL_ALLOW_SESSION } }),
    ).resolves.toBeUndefined();
    await expect(
      handler(event, {
        ui: { select: async () => Promise.reject(new Error("approval should be remembered")) },
      }),
    ).resolves.toBeUndefined();
  });
});
