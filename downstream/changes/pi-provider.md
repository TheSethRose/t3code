# Pi Provider

## Why

Upstream T3 exposes Pi as a coming-soon placeholder, but this downstream build needs the installed
Pi coding agent as a complete provider. The integration uses Pi's public RPC and extension APIs so
Pi keeps ownership of authentication, model configuration, project instructions, skills, prompts,
and extensions.

## Affected Surfaces

- `packages/contracts/src/settings.ts` defines the Pi binary path and launch arguments, while
  `packages/contracts/src/providerRuntime.ts` admits Pi's native event source.
- `apps/server/src/provider/pi/` contains the scoped JSONL transport, pre-execution approval
  extension, and focused tests.
- `apps/server/src/provider/Layers/PiAdapter.ts` implements sessions, turns, streaming content,
  tools, approvals, user input, attachments, usage, history, rollback, interruption, and cleanup.
- `apps/server/src/provider/Layers/PiProvider.ts` probes the CLI and discovers authenticated models
  and thinking levels. The same scoped RPC probe calls `get_commands`, filters Pi's native command
  inventory to `source: "skill"`, and publishes only name, description, path, and scope through
  `ServerProviderSkill`; `apps/server/src/textGeneration/PiTextGeneration.ts` implements isolated
  internal text generation.
- `apps/server/src/provider/Drivers/PiDriver.ts` and `apps/server/src/provider/builtInDrivers.ts`
  register independent Pi instances with the normal provider registry.
- Web settings and selection changes live under `apps/web/src/components/settings/`,
  `apps/web/src/components/chat/providerIconUtils.ts`, and `apps/web/src/session-logic.ts`. Desktop
  inherits the web client. Mobile selection changes live in `apps/mobile/src/components/ProviderIcon.tsx`
  and `apps/mobile/src/lib/modelOptions.ts`.
- Every executable source file and test above has a byte-identical authored copy under
  `downstream/t3code/`; `downstream.ts init` applies those copies to their normal repository paths.
- Pi remains the source of truth for skill discovery and execution. The probe runs in the configured
  T3 workspace and preserves Pi's global, project-trust, settings, package, precedence, validation,
  and symlink behavior. Active Pi sessions load the same native skills; T3 never reads or transmits
  `SKILL.md` content over its WebSocket.

Shared provider registration and picker files are owned by `provider-registry.md`.

## Overlay Files

- `apps/server/src/provider/Drivers/PiDriver.ts`
- `apps/server/src/provider/Layers/PiAdapter.test.ts`
- `apps/server/src/provider/Layers/PiAdapter.ts`
- `apps/server/src/provider/Layers/PiProvider.test.ts`
- `apps/server/src/provider/Layers/PiProvider.ts`
- `apps/server/src/provider/pi/PiApprovalExtension.test.ts`
- `apps/server/src/provider/pi/PiApprovalExtension.ts`
- `apps/server/src/provider/pi/PiRpcClient.test.ts`
- `apps/server/src/provider/pi/PiRpcClient.ts`
- `apps/server/src/textGeneration/PiTextGeneration.ts`
- `apps/web/src/components/settings/AddProviderInstanceDialog.tsx`
- `apps/web/src/components/settings/PiProviderSettings.test.ts`
- `packages/contracts/src/providerRuntime.ts`

## Validation

```bash
vp test run apps/server/src/provider/pi/PiRpcClient.test.ts \
  apps/server/src/provider/pi/PiApprovalExtension.test.ts \
  apps/server/src/provider/Layers/PiAdapter.test.ts \
  apps/server/src/provider/Layers/PiProvider.test.ts
T3_PI_CLI_PROBE=1 vp test run apps/server/src/provider/Layers/PiProvider.test.ts
(cd apps/web && vp test run --passWithNoTests --project unit src/components/settings/PiProviderSettings.test.ts)
(cd packages/contracts && vp run typecheck)
(cd apps/server && vp run typecheck)
(cd apps/web && vp run typecheck)
(cd apps/mobile && vp run typecheck)
vp node downstream/tools/downstream.test.ts
vp node downstream/tools/downstream.ts verify
git diff --check
```

The focused provider test must show that Pi's `get_commands` inventory reaches the snapshot without
extension or prompt commands. The opt-in real-CLI probe performs version, authentication, model,
thinking-level, and skill discovery but does not send an inference request. Before distributing a
build, refresh Pi in T3 and confirm a known global or trusted-project skill appears in the `$` picker,
then use a sandbox T3 home for one integrated Pi turn and confirm streaming output, a tool approval
or rejection, interruption, continuation, and clean process shutdown in web or desktop.

## Removal Condition

Remove this implementation, its `downstream/t3code/` overlays, and this record when upstream ships
equivalent Pi support with native model discovery, scoped multi-instance sessions, pre-execution
approvals, native skill inventory, normal client selection, and text generation. If upstream changes
the provider SPI first, adapt these overlays to the new SPI instead of preserving the old architecture.
