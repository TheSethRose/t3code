import { describe, expect, it } from "@effect/vitest";

import { makePiJsonlDecoder, PiRpcError, resolvePiLaunchArgs } from "./PiRpcClient.ts";

describe("Pi RPC framing", () => {
  it("splits only on LF and preserves Unicode line separators inside JSON", () => {
    const decoder = makePiJsonlDecoder();
    const encoder = new TextEncoder();

    expect(decoder.write(encoder.encode('{"text":"first\u2028second"}\r\n{"value":'))).toEqual([
      '{"text":"first\u2028second"}',
    ]);
    expect(decoder.write(encoder.encode("1}\n"))).toEqual(['{"value":1}']);
    expect(decoder.end()).toEqual([]);
  });

  it("keeps T3-owned process flags out of user launch arguments", () => {
    expect(resolvePiLaunchArgs('--provider openai-codex --model "gpt-5.6:high"')).toEqual([
      "--provider",
      "openai-codex",
      "--model",
      "gpt-5.6:high",
    ]);
    expect(() => resolvePiLaunchArgs("--mode text")).toThrow(PiRpcError);
    expect(() => resolvePiLaunchArgs("--session-id custom")).toThrow(PiRpcError);
  });
});
