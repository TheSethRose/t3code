# Hermes Provider

## Why

Hermes is a downstream first-class provider, while ACP remains its internal transport. T3 discovers
the profiles installed on the local machine and presents each profile as a selectable Hermes agent;
Hermes keeps ownership of that profile's model, credentials, memory, tools, sessions, and skills.

Each selected profile owns one lazy, long-lived `hermes -p <profile> acp` process. Every T3 thread
creates or loads its own ACP session inside that profile's process, so chat concurrency is not capped
or translated into competing same-profile Hermes processes.

## Affected Surfaces

- `HermesSettings` stores only the executable, ACP launch arguments, and optional ACP auth method.
  There is no manually entered or fabricated `default` profile.
- `HermesProfiles` discovers every profile with `hermes profile list`. T3 uses its existing model
  picker internally to select `hermes/<profile>`, but the user-facing choice is a Hermes agent.
- `HermesAcpRuntime` owns lazy, single-flight process startup per profile, one ACP connection per
  profile, multiple independent session IDs, per-session prompts and cancellation, and lazy restart
  after a transport failure.
- `HermesAdapter` maps each T3 thread to its own Hermes session ID and routes updates and approvals
  by that ID. Stopping a chat removes only its routing state; instance shutdown closes the process.
- `HermesTextGeneration` creates isolated ACP sessions on the same shared process for titles and
  source-control text.
- The provider requires Hermes 0.20.0 or newer. Every discovered profile's enabled skill catalog
  comes from `hermes -p <profile> skills list --enabled-only`; the selected profile filters the web
  and mobile skill pickers. Selected, catalog-known `$skill` tokens add a provider-only `skill_view`
  instruction while the persisted user message stays unchanged.
- Web, desktop, and mobile call the provider Hermes. They use the supplied official NousResearch
  mark in black on light themes and white on dark themes. The old generic ACP provider identity and
  ACP model filter are removed; upstream's separate ACP Registry coming-soon card remains intact.
- This version supports profiles on the same machine as T3. Remote Gateway, Hermes Cloud, and SSH
  launch modes remain out of scope until a remote connection is required.

Shared settings, provider registration, picker mappings, and mobile presentation remain owned by
`provider-registry.md`. The add-provider dialog remains owned by `pi-provider.md`.

## Overlay Files

- `apps/server/src/provider/Drivers/HermesDriver.ts`
- `apps/server/src/provider/Drivers/HermesProfiles.test.ts`
- `apps/server/src/provider/Drivers/HermesProfiles.ts`
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
- `apps/mobile/src/features/threads/new-task-flow-provider.tsx`
- `apps/web/src/components/Icons.tsx`
- `apps/web/src/components/chat/ChatComposer.tsx`
- `apps/web/src/components/settings/ProviderInstanceCard.tsx`
- `apps/web/src/components/settings/ProviderModelsSection.tsx`
- `apps/web/src/modelSelection.ts`
- `packages/contracts/src/server.ts`

## Validation

```bash
vp test run apps/server/src/provider/Layers/HermesAdapter.test.ts \
  apps/server/src/provider/Drivers/HermesProfiles.test.ts \
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

The adapter regression creates two T3 threads on one profile and another thread on a second profile.
It confirms same-profile sessions share one child PID while different profiles use different child
PIDs, with distinct ACP sessions and no fixed chat-count constant.

## Removal Condition

Remove this implementation and its overlays when upstream ships equivalent Hermes-specific profile
selection, profile-scoped skill inventory and invocation, one-process/multi-session ownership, shared
text generation, and consistent web/mobile identity. Replace the temporary wide-table skill parser
when Hermes exposes stable JSON or ACP skill inventory.
