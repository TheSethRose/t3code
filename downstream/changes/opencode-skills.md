# OpenCode Skill Inventory

## Why

OpenCode already resolves global, project, configured, and remote skills, but T3's OpenCode provider
snapshot omitted that catalog. The `$` picker therefore reported no skills even when the selected
OpenCode runtime could use them.

## Affected Surfaces

- `apps/server/src/provider/opencodeRuntime.ts` loads providers, agents, and skills through the
  pinned OpenCode SDK for managed-local and configured-external servers. Its byte-identical overlay
  is `downstream/t3code/apps/server/src/provider/opencodeRuntime.ts`.
- `apps/server/src/provider/Layers/OpenCodeProvider.ts` maps OpenCode skill metadata into the existing
  `ServerProviderSkill` contract. Its byte-identical overlay is
  `downstream/t3code/apps/server/src/provider/Layers/OpenCodeProvider.ts`.
- Focused regression tests live beside the server code and have byte-identical overlay copies. The
  existing CLI parser helpers and tests remain unchanged because the copy-only overlay cannot encode
  an upstream-file deletion; the active provider path no longer calls those helpers.
- `vite.config.ts` excludes `downstream/t3code/` from test discovery so mirrored regression tests
  remain inert overlays until `downstream.ts init` restores them into their normal T3 paths. Its
  byte-identical overlay is `downstream/t3code/vite.config.ts`.
- `downstream/docs/providers.md` documents the OpenCode SDK boundary, and `downstream/AGENTS.md`
  requires future provider work to follow it. These canonical downstream control files do not need
  overlay copies.
- Contracts, settings, persistence, orchestration, and client code are unchanged. Web, desktop,
  iOS, and Android already render `ServerProvider.skills`; old clients and servers retain the
  existing empty-array fallback.
- Local probes use a scoped managed OpenCode server. Configured external servers remain externally
  owned and receive the active workspace directory and configured Basic authentication.
- OpenCode remains responsible for skill discovery, precedence, permissions, content loading, and
  execution. T3 publishes metadata only and never sends skill bodies over its WebSocket.

## Overlay Files

- `apps/server/src/provider/Layers/OpenCodeAdapter.test.ts`
- `apps/server/src/provider/Layers/OpenCodeProvider.test.ts`
- `apps/server/src/provider/Layers/OpenCodeProvider.ts`
- `apps/server/src/provider/opencodeRuntime.ts`
- `apps/server/src/textGeneration/OpenCodeTextGeneration.test.ts`
- `vite.config.ts`

## Validation

```bash
vp test run apps/server/src/provider/Layers/OpenCodeProvider.test.ts
vp run --filter t3 typecheck
vp node downstream/tools/downstream.ts verify
git diff --check
```

The focused provider test must show that OpenCode skills reach the snapshot without their content
and that the managed-local probe closes its scope. Before distributing a build, refresh a real local
OpenCode provider and an authenticated external OpenCode server from T3 and confirm a known global
or project skill appears in the `$` picker.

## Removal Condition

Remove this deviation, its overlay files, and this record when upstream T3 populates OpenCode
provider snapshots from OpenCode's native skill inventory with equivalent local and external
lifecycle behavior. Reconcile the documentation instead of keeping a duplicate integration when the
pinned OpenCode SDK or upstream provider architecture changes.
