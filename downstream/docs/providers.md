# Provider Architecture

T3 Code separates a provider's implementation from its configured instances. A **driver** implements one protocol such as Codex or Claude; an **instance** is one configured copy of that driver, such as `codex_personal` or `codex_work`. Threads and requests route by instance ID, which is what makes multiple accounts or configurations of the same provider possible.

The upstream [provider architecture](../../docs/internals/providers.md) remains the source of truth for the shared runtime. This guide describes the downstream extension points and the extra surface and maintenance decisions required when adding a provider to the fork. Follow the linked source when a nightly changes it rather than preserving an older downstream pattern, and apply the general [Feature Lifecycle](feature-lifecycle.md) and [Compatibility](compatibility.md) rules as well.

## System Map

```text
ServerSettings.providerInstances
        |
        v
ProviderInstanceRegistryHydration
        |
        v
ProviderInstanceRegistryLive ---- unknown or broken driver
        |                                  |
        | ProviderDriver.create(...)       v
        |                         unavailable UI snapshot
        |
        +-- snapshot --------> ProviderRegistry
        |                            |
        |                            v
        |                  ServerConfig.providers
        |                            |
        |                     web / desktop / mobile
        |
        +-- adapter ---------> ProviderService
        |                            |
        |                            v
        |                  ProviderRuntimeEvent stream
        |                            |
        |                            v
        |              orchestration and persisted state
        |
        +-- textGeneration -> commit messages, PR text,
                              branch names, and thread titles
```

The main server extension point is [`ProviderDriver`](../../apps/server/src/provider/ProviderDriver.ts). A driver is a plain value rather than an Effect service because T3 must be able to run multiple isolated instances of the same implementation.

## Driver Kind and Instance ID

| Identity             | Example      | Responsibility                                                                                |
| -------------------- | ------------ | --------------------------------------------------------------------------------------------- |
| `ProviderDriverKind` | `codex`      | Selects the protocol implementation, configuration decoder, and default presentation.         |
| `ProviderInstanceId` | `codex_work` | Selects the exact configured process, account, environment, model catalog, and session owner. |

Both are open branded strings in [`providerInstance.ts`](../../packages/contracts/src/providerInstance.ts), so an unknown downstream driver can survive settings and wire decoding. Code that sends work must route by `instanceId`; code that describes protocol-specific behavior may branch on `driverKind`.

`ProviderInstanceConfig` is the persisted envelope. It contains the driver kind, optional display name and accent color, environment variables, enabled state, and an opaque `config` value. The selected driver decodes that value with its own schema.

T3 still synthesizes default instance IDs from the legacy fixed provider settings. [`ProviderInstanceRegistryHydration`](../../apps/server/src/provider/Layers/ProviderInstanceRegistryHydration.ts) merges those defaults with the newer `providerInstances` map, with explicit instance configuration winning.

## What a Driver Creates

Every built-in driver exports a `ProviderDriver` with four parts:

- `driverKind` is its stable slug.
- `metadata` supplies its display name and whether multiple instances are allowed.
- `configSchema` and `defaultConfig` turn the opaque settings payload into typed configuration.
- `create` materializes one isolated `ProviderInstance` inside a registry-owned Effect scope.

The created instance contains three operational components:

1. **Snapshot.** The [`ServerProvider`](../../apps/server/src/provider/Services/ServerProvider.ts) service probes installation, version, authentication, models, skills, commands, and update state. [`makeManagedServerProvider`](../../apps/server/src/provider/makeManagedServerProvider.ts) manages initial probing, refreshes, settings changes, and snapshot streaming.
2. **Conversation adapter.** The [`ProviderAdapter`](../../apps/server/src/provider/Services/ProviderAdapter.ts) service starts and resumes sessions, sends and interrupts turns, answers approval and user-input requests, reads or rolls back threads, stops sessions, and emits canonical runtime events.
3. **Text generation.** The instance supplies a [`TextGeneration`](../../apps/server/src/textGeneration/TextGeneration.ts) implementation for small internal jobs such as commit messages, pull-request text, branch names, and thread titles. This is separate from interactive conversations but uses the same configured instance.

All mutable state belongs to the instance's scope: process handles, event topics, references, watchers, and authentication context. Closing or reconfiguring one instance must not affect another instance of the same driver.

## Current Provider Implementations

| Driver   | Interactive protocol                                                                                                               | Status and models                                                                  | Text generation                                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Codex    | Typed Codex app-server runtime in [`CodexAdapter.ts`](../../apps/server/src/provider/Layers/CodexAdapter.ts)                       | [`CodexProvider.ts`](../../apps/server/src/provider/Layers/CodexProvider.ts)       | [`CodexTextGeneration.ts`](../../apps/server/src/textGeneration/CodexTextGeneration.ts) uses `codex exec`.                |
| Claude   | Anthropic Agent SDK sessions in [`ClaudeAdapter.ts`](../../apps/server/src/provider/Layers/ClaudeAdapter.ts)                       | [`ClaudeProvider.ts`](../../apps/server/src/provider/Layers/ClaudeProvider.ts)     | [`ClaudeTextGeneration.ts`](../../apps/server/src/textGeneration/ClaudeTextGeneration.ts) uses `claude -p`.               |
| Cursor   | ACP over the Cursor agent CLI in [`CursorAdapter.ts`](../../apps/server/src/provider/Layers/CursorAdapter.ts)                      | [`CursorProvider.ts`](../../apps/server/src/provider/Layers/CursorProvider.ts)     | [`CursorTextGeneration.ts`](../../apps/server/src/textGeneration/CursorTextGeneration.ts) uses ACP.                       |
| Grok     | ACP over the Grok CLI in [`GrokAdapter.ts`](../../apps/server/src/provider/Layers/GrokAdapter.ts)                                  | [`GrokProvider.ts`](../../apps/server/src/provider/Layers/GrokProvider.ts)         | [`GrokTextGeneration.ts`](../../apps/server/src/textGeneration/GrokTextGeneration.ts) uses ACP.                           |
| OpenCode | OpenCode SDK plus a managed or external server in [`OpenCodeAdapter.ts`](../../apps/server/src/provider/Layers/OpenCodeAdapter.ts) | [`OpenCodeProvider.ts`](../../apps/server/src/provider/Layers/OpenCodeProvider.ts) | [`OpenCodeTextGeneration.ts`](../../apps/server/src/textGeneration/OpenCodeTextGeneration.ts) uses the OpenCode runtime.  |
| Pi       | Pi's native LF-delimited RPC mode in [`PiAdapter.ts`](../../apps/server/src/provider/Layers/PiAdapter.ts)                          | [`PiProvider.ts`](../../apps/server/src/provider/Layers/PiProvider.ts)             | [`PiTextGeneration.ts`](../../apps/server/src/textGeneration/PiTextGeneration.ts) uses isolated no-session RPC processes. |

The corresponding factories live in [`apps/server/src/provider/Drivers`](../../apps/server/src/provider/Drivers). [`builtInDrivers.ts`](../../apps/server/src/provider/builtInDrivers.ts) is the static server catalog and the one registration point for a new built-in driver.

ACP is useful shared transport machinery, but it does not make Cursor and Grok the same provider. Each driver still owns its executable, configuration, extensions, capabilities, status probe, and presentation.

## Pi RPC

The downstream Pi driver launches the user's installed `pi` binary in RPC mode and keeps all Pi
configuration native. T3 does not embed the Pi SDK, copy credentials, or rebuild Pi's model and
resource system. The status probe asks the running CLI for its authenticated models and supported
thinking levels, so the model picker reflects the user's actual Pi setup rather than a static list.

[`PiRpcClient.ts`](../../apps/server/src/provider/pi/PiRpcClient.ts) owns only Pi's JSONL framing,
request correlation, event stream, bounded stderr diagnostics, and scoped process shutdown.
[`PiAdapter.ts`](../../apps/server/src/provider/Layers/PiAdapter.ts) maps that protocol into the same
session, turn, content, tool, approval, user-input, usage, history, and rollback contracts used by
the other providers. Each configured Pi instance owns its processes and sessions independently.

Pi does not have a native permission dialog, so T3 loads its bundled
[`PiApprovalExtension.ts`](../../apps/server/src/provider/pi/PiApprovalExtension.ts) into interactive
sessions. The extension intercepts Pi's public `tool_call` hook before execution, sends the request
through Pi's extension UI RPC channel, and waits for the canonical T3 response. Full-access mode is
the only automatic path; the other runtime modes block until the user allows or rejects the tool.

## OpenCode SDK

OpenCode integration uses the pinned `@opencode-ai/sdk` package as its protocol boundary. Read the
installed SDK types before changing a call because the generated client follows the pinned OpenCode
API, not whichever CLI happens to be installed globally. Keep SDK calls in
[`opencodeRuntime.ts`](../../apps/server/src/provider/opencodeRuntime.ts); provider snapshots,
conversation adapters, and text generation consume that runtime instead of creating their own
clients or reconstructing API responses from CLI output.

Create clients through `createOpenCodeSdkClient`. It supplies the configured base URL, the active
T3 workspace as `directory`, and Basic authentication for a configured external server. Directory
propagation is required because OpenCode resolves project configuration, agents, skills, and other
workspace-local state from that directory. Never replace it with `process.cwd()`.

Use `connectToOpenCodeServer` inside an Effect scope for both connection modes. A configured server
URL is externally owned and must not be stopped by T3. Without a URL, the runtime starts a managed
local server and its scope finalizer owns shutdown. Do not start an unscoped server, kill a process
by name, or let a status probe retain a server after its scope closes.

Load provider metadata through the generated SDK endpoints:

- `client.provider.list()` supplies connected upstream providers and models.
- `client.app.agents()` supplies the agent catalog used for model options.
- `client.app.skills()` supplies OpenCode's resolved skill catalog.

OpenCode owns skill discovery, source precedence, configuration, permissions, and native loading.
T3 maps the returned name, description, and location into `ServerProviderSkill` so existing web,
desktop, and mobile pickers can render the catalog. T3 must discard the returned skill body and must
not put it in a provider snapshot, WebSocket message, log, or cache; OpenCode loads the body through
its native `skill` tool when the agent uses it. This also preserves global `~/.agents/skills`,
project-local skills, custom paths, remote catalogs, and future OpenCode discovery rules without a
parallel T3 filesystem scanner.

Wrap promise calls with `runOpenCodeSdk` so failures remain typed `OpenCodeRuntimeError` values and
retain operation-specific diagnostics. A required inventory call may fail the status probe rather
than publishing a misleading partial snapshot. When the pinned SDK or minimum supported OpenCode
version changes, re-read the generated method and response types, update this section with any
changed lifecycle or mapping rule, and verify both managed-local and authenticated-external paths.

## From a User Turn to a Provider Process

1. **The client selects an instance.** A thread's [`ModelSelection`](../../packages/contracts/src/model.ts) records `instanceId`, model, and any model-specific option selections.
2. **The command reactor resolves it.** [`ProviderCommandReactor`](../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts) looks up the selected instance, checks its capabilities, and decides whether to start, resume, restart, or continue a session.
3. **The provider service routes exactly.** [`ProviderService`](../../apps/server/src/provider/Layers/ProviderService.ts) validates the request, finds the adapter for that instance, records session ownership, and invokes the adapter method.
4. **The adapter speaks the native protocol.** It launches or contacts the provider runtime and translates the request into that provider's SDK, JSON-RPC, ACP, or CLI protocol.
5. **The adapter normalizes events.** Native messages become the canonical [`ProviderRuntimeEvent`](../../packages/contracts/src/providerRuntime.ts) types used by the rest of T3. Provider-native payloads must not leak into orchestration or clients.
6. **Runtime ingestion persists behavior.** [`ProviderRuntimeIngestion`](../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts) turns normalized provider events into the commands and persisted events that update T3's read model.
7. **Clients render shared state.** Web and mobile receive the updated thread state and provider snapshots; desktop uses the web client inside its Electron shell.

Approvals, user-input requests, tool progress, content deltas, tasks, hooks, authentication changes, and runtime errors all use the same normalized event path. That common path is why a new adapter must translate the full behavior it supports instead of sending provider-specific objects through the system.

## Registry and Reload Behavior

[`ProviderInstanceRegistryLive`](../../apps/server/src/provider/Layers/ProviderInstanceRegistryLive.ts) owns the live map of instance IDs to materialized instances. Each instance gets a child scope; removing or changing its configuration closes only that scope and rebuilds only that instance.

An unknown driver, invalid configuration, or factory failure becomes an unavailable shadow snapshot. T3 preserves the configured instance and explains that it cannot run rather than crashing the registry or silently deleting settings. [`ProviderAdapterRegistry`](../../apps/server/src/provider/Layers/ProviderAdapterRegistry.ts) routes conversation work, while [`ProviderRegistry`](../../apps/server/src/provider/Layers/ProviderRegistry.ts) aggregates the status snapshots streamed to clients.

## Client Exposure

The server publishes each configured instance as a [`ServerProvider`](../../packages/contracts/src/server.ts). The shared client runtime stores those dynamic snapshots in [`packages/client-runtime/src/state/server.ts`](../../packages/client-runtime/src/state/server.ts).

The web client is instance-aware in [`providerInstances.ts`](../../apps/web/src/providerInstances.ts) and formats model capabilities in [`providerModels.ts`](../../apps/web/src/providerModels.ts). Desktop inherits this behavior from web. Mobile derives its available choices from server snapshots in [`modelOptions.ts`](../../apps/mobile/src/lib/modelOptions.ts).

Some presentation and settings code is still manually keyed by built-in driver:

- [`providerDriverMeta.ts`](../../apps/web/src/components/settings/providerDriverMeta.ts) registers the web label, icon, badge, and configuration schema used by the add-provider and settings forms.
- [`ProviderSettingsForm.tsx`](../../apps/web/src/components/settings/ProviderSettingsForm.tsx) renders schema annotations into the generic web form.
- [`ProviderIcon.tsx`](../../apps/mobile/src/components/ProviderIcon.tsx) selects the mobile icon.
- [`model.ts`](../../packages/contracts/src/model.ts) contains built-in display names, default models, text-generation defaults, and model aliases.
- [`settings.ts`](../../packages/contracts/src/settings.ts) still contains the built-in driver configuration schemas used by current settings UI.

The open contracts let an unknown driver round-trip, but a polished downstream provider still needs these explicit client entries until upstream finishes moving all driver metadata and configuration schemas behind the driver SPI.

## Adding a Downstream Provider

Use a short-lived feature branch and make the provider one independently removable downstream change.

1. **Define the contract-facing identity and settings.** Choose a stable driver slug, add its current settings schema and defaults where the UI expects them, and add model defaults or aliases only when the provider needs them.
2. **Implement the status snapshot.** Detect the executable or service, version, authentication, supported models, commands, and skills. Refresh must report actionable unavailability without preventing the server from starting.
3. **Implement the conversation adapter.** Cover every applicable `ProviderAdapter` operation, translate native messages into canonical runtime events, correlate sessions to the exact instance ID, and release processes and subscriptions with the instance scope.
4. **Implement text generation.** Use the provider's supported non-interactive path for T3's internal generation jobs and return structured errors when the runtime is unavailable.
5. **Create and register the driver.** Follow a sibling factory in `apps/server/src/provider/Drivers`, add it to `BUILT_IN_DRIVERS`, and satisfy any new infrastructure dependency in the server runtime layer.
6. **Expose configuration and presentation.** Add the web driver metadata and icon, verify the generic settings form, add the mobile icon, and confirm unknown or unavailable states remain understandable.
7. **Exercise every applicable surface.** Test web and desktop configuration, web and mobile model selection, local and remote connections, authentication changes, session continuation, approvals, interruption, stopping, and any provider-specific capabilities.
8. **Record the deviation.** Put normal source and tests in their normal repository paths, mirror every downstream-owned file under `downstream/t3code/`, and add `downstream/changes/<provider-slug>.md` with its reason, affected surfaces, exact validation commands, and upstream removal condition.

Do not copy an existing adapter only because its provider also uses a CLI. Reuse a shared protocol layer such as ACP when the wire behavior truly matches, then keep executable discovery, configuration, extensions, capabilities, and lifecycle inside the new driver.

## Minimum Validation

The provider's change record must list concrete commands for its actual files. A typical focused pass includes:

```bash
vp test run <provider adapter and driver tests>
vp run --filter t3 typecheck
vp run --filter @t3tools/contracts typecheck
vp run --filter @t3tools/client-runtime typecheck
vp run --filter @t3tools/web typecheck
vp run --filter @t3tools/mobile typecheck
vp node downstream/tools/downstream.ts verify
```

Add one integrated client pass for user-visible behavior when requested. The proof should show installation and authentication states, model discovery and selection, one completed turn, streaming output, interruption, continuation, and clean shutdown through the actual provider runtime.

## Nightly Maintenance

During each nightly roll, inspect upstream changes to the driver SPI, provider contracts, registry lifecycle, runtime events, settings UI, and model selectors before restoring the overlay. Update the working source and its `downstream/t3code/` counterpart together, then run the provider change record's validation and `downstream.ts verify`.

If upstream adds equivalent support, remove the downstream implementation, overlay files, and active change record in the same roll. If upstream changes only the shared architecture, adapt the downstream provider to the new pattern instead of preserving obsolete interfaces in a compatibility layer.
