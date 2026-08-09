# Provider switching between turns

GitHub: #4

## Why

A settled T3 thread should be able to continue on another configured provider without losing its
canonical transcript, workspace, or checkpoints. Provider-native cursors remain an optimization;
when continuation identities are incompatible, T3 starts a fresh target session and supplies bounded
visible history once as provider-only turn input.

## Affected Surfaces

- Provider orchestration chooses active reuse, compatible cursor resume, or fresh history handoff at
  settled turn boundaries and rejects switches while turns or callbacks are live.
- Provider session persistence clears foreign cursor/runtime state and tracks the current native
  segment checkpoint boundary.
- Checkpoint revert invalidates native state when crossing below that segment boundary.
- Shared client liveness drives web/desktop and mobile provider picker availability.
- Mobile queued turns retain their captured model selection.
- Codex and Claude user guides explain compatible resume versus fresh visible-history handoff.
- Existing provider session and turn contracts carry the internal segment marker; no new wire command
  or transcript store is added.

## Overlay Files

- `apps/mobile/src/features/threads/ThreadComposer.tsx`
- `apps/mobile/src/state/thread-outbox.test.ts`
- `apps/server/integration/OrchestrationEngineHarness.integration.ts`
- `apps/server/src/orchestration/Layers/CheckpointReactor.test.ts`
- `apps/server/src/orchestration/Layers/CheckpointReactor.ts`
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`
- `apps/server/src/provider/Layers/ProviderService.test.ts`
- `apps/server/src/provider/Layers/ProviderService.ts`
- `apps/server/src/provider/Layers/ProviderSessionDirectory.test.ts`
- `apps/server/src/provider/Layers/ProviderSessionDirectory.ts`
- `apps/web/src/components/ChatView.logic.test.ts`
- `apps/web/src/components/ChatView.logic.ts`
- `apps/web/src/components/ChatView.tsx`
- `docs/user/providers-claude.md`
- `docs/user/providers-codex.md`
- `packages/client-runtime/src/state/threadSettled.test.ts`
- `packages/client-runtime/src/state/threadSettled.ts`
- `packages/contracts/src/provider.test.ts`
- `packages/contracts/src/provider.ts`

## Validation

```bash
vp test run apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts \
  apps/server/src/orchestration/Layers/CheckpointReactor.test.ts \
  apps/server/src/provider/Layers/ProviderSessionDirectory.test.ts \
  apps/server/src/provider/Layers/ProviderService.test.ts
vp test run packages/client-runtime/src/state/threadSettled.test.ts \
  apps/web/src/components/ChatView.logic.test.ts \
  apps/mobile/src/state/thread-outbox.test.ts \
  packages/contracts/src/provider.test.ts
(cd packages/contracts && vp run typecheck)
(cd packages/client-runtime && vp run typecheck)
(cd apps/server && vp run typecheck)
(cd apps/web && vp run typecheck)
(cd apps/mobile && vp run typecheck)
vp node downstream/tools/downstream.test.ts
vp node downstream/tools/downstream.ts verify
git diff --check
```

## Removal Condition

Remove this change, its overlays, and this record when upstream supports settled cross-provider
thread continuation with deterministic bounded visible-history handoff, cursor/runtime invalidation,
cross-segment checkpoint revert handling, and matching web and mobile picker behavior.
