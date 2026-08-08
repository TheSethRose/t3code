# Generic ACP Provider

Status: planned
Priority: first
Reference: [Provider architecture](../providers.md)

## Goal

Add a provider-neutral Agent Client Protocol (ACP) driver and validate it with the locally installed Hermes Agent. The integration must use T3 Code's existing provider contracts and ACP runtime rather than introduce Hermes-specific behavior.

The first configured instance should be equivalent to:

```yaml
driver: acp
instanceId: acp_hermes
displayName: Hermes
binaryPath: hermes
launchArgs: acp
authMethodId: opencode-go
```

## What already exists

T3 Code already has most of the protocol machinery needed for this provider:

- `packages/effect-acp` provides the typed ACP client, generated schemas, JSON-RPC transport, stdio framing, terminal support, and protocol errors.
- `apps/server/src/provider/acp/AcpSessionRuntime.ts` already owns process startup, initialization, authentication, sessions, prompts, cancellation, modes, models, requests, and extensions.
- Cursor and Grok provide working ACP driver, adapter, status, model-discovery, and text-generation patterns.
- Existing ACP tests include a mock agent and optional real-CLI probes.

Hermes `0.20.0` has also completed an initialize handshake through the current ACP client. It reported ACP protocol version 1, load/fork/list/resume support, image prompts, and the `opencode-go` agent-owned authentication method. This proves protocol compatibility, but it does not prove a complete T3 turn yet.

## Minimum implementation

### 1. Configuration and driver

Add `AcpSettings` with only the settings that belong to the ACP process:

- `binaryPath`
- `launchArgs`
- optional `authMethodId`

The existing provider-instance envelope continues to own the instance ID, display name, environment, and enabled state. Register an `acp` driver in the normal built-in driver registry, and use `tokenizeCliArgs` plus `resolveSpawnCommand` so commands are never passed through a shell.

### 2. Runtime and authentication

Wrap `AcpSessionRuntime` with a provider-neutral runtime instead of copying the Cursor or Grok implementations. Authentication selection must follow this order:

1. Use the configured `authMethodId` when the agent advertises it.
2. Otherwise choose a safe agent-owned method when one is available.
3. Never launch terminal or interactive authentication automatically.

Expose ACP session list, fork, resume, and close operations when the agent advertises them. The underlying client already implements these operations; the runtime wrapper only needs to make them available to the adapter.

### 3. Adapter and events

Implement the standard `ProviderAdapter` lifecycle using the shared ACP runtime:

- start and resume a thread
- prompt and stream canonical runtime events
- cancel or stop a running turn
- read thread history
- list, fork, and close sessions where supported
- clean up the exact child process and runtime scope

Keep vendor extensions outside the generic adapter. Unsupported extension events should remain visible in logs without changing the shared orchestration model.

### 4. Status, models, and text generation

Build the provider snapshot from executable discovery, version output, ACP initialization, and session model configuration. Use `acp/default` only when the agent exposes model selection after a session starts and cannot provide a better preflight model list.

Implement text generation with the same short-lived structured-prompt pattern used by the Cursor ACP provider. It must use an isolated ACP session and cleanly shut it down after completion or failure.

### 5. Client surfaces

Replace the disabled ACP Registry placeholder with a configurable ACP provider entry. Add the existing ACP icon and provider metadata to web, desktop, and mobile selection surfaces without adding Hermes-specific UI.

## Expected implementation surfaces

- Provider contracts and settings schema
- `apps/server/src/provider/acp/`
- built-in driver registration
- provider status and model discovery
- provider text generation
- web and mobile provider definitions/icons
- focused server and contract tests
- `downstream/t3code/` overlays for every changed upstream file
- one active `downstream/changes/` record while the integration differs from upstream

Exact filenames should follow the current upstream layout at implementation time; this plan should not freeze a stale file map across nightly updates.

## Validation

Focused automated coverage must prove:

- settings decode and command construction
- authentication selection, including refusal to auto-run terminal auth
- canonical event mapping and adapter lifecycle
- process exit, cancellation, and scoped cleanup
- multiple ACP instances remain isolated
- unavailable binaries produce a truthful provider snapshot
- list, fork, resume, and close are capability-gated
- the mock ACP agent completes a streamed turn

An opt-in Hermes probe may verify discovery without making a paid or mutating inference request. Final manual validation must then configure Hermes, complete one real streamed turn, exercise an approval or tool request, interrupt or resume the session, and confirm clean shutdown.

## Done when

- Two ACP instances can be configured without sharing runtime state.
- Hermes appears ready with its discovered identity, capabilities, authentication, and available model information.
- A Hermes turn streams through T3's normal events, including tools and approvals.
- Interrupt, resume, stop, and text generation work without orphaning a process.
- Web, desktop, and mobile can select the configured ACP instance.
- The implementation is represented by exact downstream overlays and an active change record.

## Deliberately excluded

- A Hermes-specific adapter or Hermes branches in shared orchestration
- A second ACP library or protocol framework
- Automatic terminal-login flows
- General support for arbitrary vendor extensions
- Copying the Cursor or Grok provider wholesale
