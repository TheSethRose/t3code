# Hermes Provider

## Why

Hermes is a downstream first-class provider, while ACP remains its internal transport. Users choose
a Hermes provider instance backed by one explicit profile; Hermes keeps ownership of that profile's
model, credentials, memory, tools, sessions, and skills.

One provider instance owns one long-lived `hermes -p <profile> acp` process. Every T3 thread creates
or loads its own ACP session inside that process, so the number of chats is not capped or translated
into competing same-profile Hermes processes.

## Affected Surfaces

- `HermesSettings` stores the executable, explicit profile, ACP launch arguments, and optional ACP
  auth method. T3 exposes one fixed `hermes/<profile>` picker entry instead of Hermes' model catalog.
- `HermesAcpRuntime` owns lazy, single-flight process startup, one ACP connection per provider
  instance, multiple independent session IDs, per-session prompts and cancellation, and lazy restart
  after a transport failure.
- `HermesAdapter` maps each T3 thread to its own Hermes session ID and routes updates and approvals
  by that ID. Stopping a chat removes only its routing state; instance shutdown closes the process.
- `HermesTextGeneration` creates isolated ACP sessions on the same shared process for titles and
  source-control text.
- The provider requires Hermes 0.20.0 or newer. The enabled skill catalog comes from
  `hermes -p <profile> skills list --enabled-only`; the command is run with a wide non-color terminal
  so names are not truncated. Selected, catalog-known `$skill` tokens add a provider-only
  `skill_view` instruction while the persisted user message stays unchanged.
- Web, desktop, and mobile call the provider Hermes. They use the supplied official NousResearch
  mark in black on light themes and white on dark themes. The invented ACP mark, ACP model filter,
  and ACP Registry coming-soon card are removed.
- Multiple configured Hermes instances support multiple profiles. The profile field accepts the
  exact Hermes profile name; T3 does not create, edit, or assign models to profiles.

Shared settings, provider registration, picker mappings, and mobile presentation remain owned by
`provider-registry.md`. The add-provider dialog remains owned by `pi-provider.md`.

## Overlay Files

- `apps/server/src/provider/Drivers/HermesDriver.ts`
- `apps/server/src/provider/Drivers/HermesSkills.test.ts`
- `apps/server/src/provider/Drivers/HermesSkills.ts`
- `apps/server/src/provider/Layers/HermesAdapter.test.ts`
- `apps/server/src/provider/Layers/HermesAdapter.ts`
- `apps/server/src/provider/Layers/HermesProvider.ts`
- `apps/server/src/provider/Layers/fixtures/hermes-adapter-mock-peer.ts`
- `apps/server/src/provider/Layers/fixtures/hermes-adapter-mock`
- `apps/server/src/provider/acp/AcpSessionRuntime.ts`
- `apps/server/src/provider/acp/HermesAcpRuntime.ts`
- `apps/server/src/textGeneration/HermesTextGeneration.ts`
- `apps/web/src/components/Icons.tsx`
- `apps/web/src/components/settings/ProviderInstanceCard.tsx`
- `apps/web/src/components/settings/ProviderModelsSection.tsx`
- `apps/web/src/modelSelection.ts`

## Validation

```bash
vp test run apps/server/src/provider/Layers/HermesAdapter.test.ts \
  apps/server/src/provider/Drivers/HermesSkills.test.ts \
  packages/contracts/src/settings.test.ts
vp run --filter @t3tools/contracts typecheck
vp run --filter t3 typecheck
vp run --filter @t3tools/web typecheck
vp run --filter @t3tools/mobile typecheck
vp node downstream/tools/downstream.test.ts
vp node downstream/tools/downstream.ts verify
git diff --check
```

The adapter regression creates two T3 threads, receives a distinct Hermes ACP session ID for each,
sends prompts concurrently, and confirms both are handled by the same child PID. It also covers
profile auth selection, approvals, skill invocation, interruption, and isolated cleanup without a
fixed chat-count constant.

## Removal Condition

Remove this implementation and its overlays when upstream ships equivalent Hermes-specific profile
selection, profile-scoped skill inventory and invocation, one-process/multi-session ownership, shared
text generation, and consistent web/mobile identity. Replace the temporary wide-table skill parser
when Hermes exposes stable JSON or ACP skill inventory.
