# ACP Provider

## Why

Add a provider-neutral ACP (Agent Client Protocol) driver so any ACP-compatible agent (e.g. Hermes) can plug into T3 as a first-class provider. Uses existing `packages/effect-acp` typed client and `AcpSessionRuntime` process management already proven by Cursor and Grok.

## Affected Surfaces

- `packages/contracts/src/settings.ts` — `AcpSettings` schema with `binaryPath`, `launchArgs`, `authMethodId`, `customModels`
- `apps/server/src/provider/acp/AcpGenericSupport.ts` — generic ACP runtime factory (no vendor-specific logic)
- `apps/server/src/provider/acp/AcpSessionRuntime.ts` — auto-selects advertised agent-managed auth when no method is configured; terminal setup remains manual
- `apps/server/src/provider/Layers/AcpProvider.ts` — executable discovery, ACP init handshake, model discovery
- `apps/server/src/provider/Layers/AcpAdapter.ts` — session lifecycle, turn streaming, approvals, interruption, cleanup
- `apps/server/src/provider/Layers/AcpAdapter.test.ts` — subprocess regression for auth, Hermes permission scopes, repeated turns, and interruption
- `apps/server/src/textGeneration/AcpTextGeneration.ts` — isolated ACP sessions for structured text generation
- `apps/server/src/provider/Drivers/AcpDriver.ts` — `ProviderDriver` factory, wires snapshot/adapter/textGen in scoped instance
- `apps/server/src/provider/builtInDrivers.ts` — registers `AcpDriver` in `BUILT_IN_DRIVERS`
- `apps/web/src/components/Icons.tsx` — `AcpAgentIcon`
- `apps/web/src/components/settings/ProviderModelsSection.tsx` — filters large ACP model inventories while preserving the same input for custom model entry
- `apps/web/src/components/settings/ProviderModelsSection.test.ts` — focused ACP model-filter regression
- `apps/web/src/components/settings/providerDriverMeta.ts` — acp entry with label, icon, badge, schema
- `apps/web/src/components/chat/providerIconUtils.ts` — acp icon mapping
- `apps/web/src/session-logic.ts` — acp in provider picker
- `apps/mobile/src/components/ProviderIcon.tsx` — acp icon
- `apps/mobile/src/lib/modelOptions.ts` — acp display label

Shared provider registration and picker files are owned by `provider-registry.md`.

## Overlay Files

- `apps/server/src/provider/Drivers/AcpDriver.ts`
- `apps/server/src/provider/Layers/AcpAdapter.test.ts`
- `apps/server/src/provider/Layers/AcpAdapter.ts`
- `apps/server/src/provider/Layers/fixtures/acp-adapter-mock-peer.ts`
- `apps/server/src/provider/Layers/AcpProvider.ts`
- `apps/server/src/provider/acp/AcpGenericSupport.ts`
- `apps/server/src/provider/acp/AcpSessionRuntime.ts`
- `apps/server/src/textGeneration/AcpTextGeneration.ts`
- `apps/web/src/components/Icons.tsx`
- `apps/web/src/components/settings/ProviderModelsSection.test.ts`
- `apps/web/src/components/settings/ProviderModelsSection.tsx`

## Validation

```bash
(cd apps/server && vp test run src/provider/Layers/AcpAdapter.test.ts)
(cd packages/contracts && vp run typecheck)
(cd apps/server && vp run typecheck)
(cd apps/web && vp test run --passWithNoTests --project unit src/components/settings/ProviderModelsSection.test.ts)
(cd apps/web && vp run typecheck)
(cd apps/mobile && vp run typecheck)
vp node downstream/tools/downstream.test.ts
vp node downstream/tools/downstream.ts verify
```

## Removal Condition

Remove when upstream ships equivalent generic ACP provider support with multi-instance sessions, capability-gated operations, and normal client selection. If upstream changes only the provider SPI, adapt overlays to the new pattern.
