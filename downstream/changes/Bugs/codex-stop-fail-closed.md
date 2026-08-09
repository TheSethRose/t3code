# Codex Stop Fails Closed

## Why

Codex can reject `turn/interrupt` when T3's cached active turn ID is stale while the provider keeps
executing the newer turn. A hung interrupt request can also leave Stop waiting indefinitely. Stop
must end the exact Codex session when graceful interruption cannot be confirmed promptly.

## Affected Surfaces

- `apps/server/src/provider/Layers/CodexSessionRuntime.ts` preserves the active turn ID when Codex
  accepts a queued follow-up, sends root and collaboration-child interrupts concurrently, and
  requires all of them to finish within five seconds.
- `apps/server/src/provider/Layers/CodexAdapter.ts` closes only the affected Codex session when any
  interrupt is rejected or exceeds the deadline. The next turn uses the existing session startup
  and resume path.
- Focused adapter and real-process collaboration regressions live beside the provider code. Their
  byte-identical copies under `downstream/t3code/` remain inert until the downstream initializer
  restores them to the normal test paths.
- Web, desktop, and mobile use the same server interruption path. Contracts, persistence, clients,
  and non-Codex providers are unchanged.

## Overlay Files

- `apps/server/src/provider/Layers/CodexAdapter.test.ts`
- `apps/server/src/provider/Layers/CodexAdapter.ts`
- `apps/server/src/provider/Layers/CodexCollabRuntime.integration.test.ts`
- `apps/server/src/provider/Layers/CodexSessionRuntime.ts`

## Validation

```bash
vp test run apps/server/src/provider/Layers/CodexSessionRuntime.test.ts \
  apps/server/src/provider/Layers/CodexAdapter.test.ts \
  apps/server/src/provider/Layers/CodexCollabRuntime.integration.test.ts
vp run --filter t3 typecheck
vp node --test downstream/tools/downstream.test.ts
vp exec tsgo -p downstream/tools/tsconfig.json --noEmit
vp node downstream/tools/downstream.ts verify
git diff --check
```

The focused tests must prove that a normal interrupt preserves its session, rejected and hung
interrupts close only the affected session, and root plus child interrupts start concurrently under
the shared deadline.

## Removal Condition

Remove this deviation, its overlays, and this record when upstream provides bounded, confirmed
Codex interruption with an exact-session fail-closed fallback for rejected or hung root and child
turns.
