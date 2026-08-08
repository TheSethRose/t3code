# Pi Provider

Status: implemented downstream
Active change: [Pi provider](../../changes/pi-provider.md)
Reference: [Provider architecture](../providers.md)

## Goal

Add Pi as a native T3 provider by running the user's installed `pi` CLI in RPC mode. The integration must preserve Pi's normal local configuration and resources while translating its JSONL protocol into T3's existing provider contracts.

## What already exists

The installed Pi CLI is `@earendil-works/pi-coding-agent` version `0.83.0` and supports `pi --mode rpc`. Its line-delimited JSON protocol already exposes prompting, steering, aborts, images, session history, model and thinking selection, forks, context statistics, streamed messages, tool events, and extension UI requests.

T3 Code currently has a Pi icon and a disabled provider placeholder, but it has no Pi runtime, transport, adapter, or dependency. An older downstream fork embedded an obsolete Pi SDK behind a singleton manager; only its behavioral mapping is useful. Do not port that architecture or add its old package.

## Minimum implementation

### 1. Configuration and driver

Add `PiSettings` with:

- `binaryPath`, defaulting to `pi`
- optional `launchArgs`

The existing provider-instance envelope owns all shared fields. Register a `pi` built-in driver and spawn `pi --mode rpc` directly without a shell.

### 2. RPC transport

Implement the smallest Pi-specific transport needed by the adapter:

- strict LF-delimited JSON parsing on stdout
- request IDs and response correlation
- a stream of unsolicited Pi events
- bounded stderr capture for diagnostics
- rejection of pending requests when the child exits
- exact, scope-owned process shutdown

Do not expose a generic transport abstraction until a second protocol actually needs it.

### 3. Approval bridge

Pi intentionally has no built-in permission popups, so a full provider cannot rely on RPC mode alone. Ship one T3-owned Pi extension, loaded explicitly for T3 sessions, that intercepts Pi's public `tool_call` hook and waits for a T3 decision before the tool executes.

Map the extension request and response onto T3's canonical approval and user-input events. Full-access mode may approve automatically; restricted modes must block until the user responds. This behavior is required for completion because a notification emitted after tool execution is not an approval system.

### 4. Adapter and events

Implement the standard `ProviderAdapter` operations using Pi RPC:

- start or resume with a Pi session ID or path
- prompt, steer, and abort
- map text, thinking, message, and tool events into `ProviderRuntimeEvent`
- finish the turn on Pi's `agent_settled` event
- rebuild thread history with `get_messages`
- use session entries and forks for rollback
- list, stop, and clean up active sessions
- translate T3 image attachments into Pi prompt inputs

Pi's normal project instructions, skills, prompts, extensions, models, and authentication remain enabled. T3 should add only its approval extension and must not read or copy Pi secrets.

### 5. Models, status, and text generation

Use `get_available_models` for authenticated model discovery, `set_model` for session selection, and Pi's thinking-level commands for the T3 reasoning control. Map image capability, context limits, token use, and cost statistics when Pi reports them.

The provider snapshot should combine `pi --version` with a short `--no-session` RPC probe. Static `--list-models` output is not sufficient proof that a model is authenticated and usable.

Implement text generation with an isolated `pi --mode rpc --no-session` process, applying the requested model and thinking level before sending the structured prompt.

### 6. Client surfaces and packaging

Move Pi out of the coming-soon list and add it to the normal web, desktop, and mobile provider selection surfaces. Package the approval extension with the server and desktop artifacts so the same runtime behavior is available outside the source checkout.

## Expected implementation surfaces

- Provider contracts and settings schema
- a Pi RPC transport and process runtime under the server provider code
- the T3 Pi approval extension
- Pi adapter, status, model discovery, and text generation
- built-in driver registration
- web and mobile provider definitions/icons
- desktop/server packaging inputs for the extension
- focused transport, adapter, driver, and contract tests
- `downstream/t3code/` overlays for every changed upstream file
- one active `downstream/changes/` record while the integration differs from upstream

Exact filenames should follow the current upstream layout at implementation time; this plan should not freeze a stale file map across nightly updates.

## Validation

Use a mock Pi JSONL process to prove:

- LF framing, request correlation, event delivery, stderr capture, and process-exit errors
- prompt, steer, abort, history, rollback, and session cleanup
- message, thinking, tool, usage, and settled-event mapping
- approval blocks before a tool runs and resumes only after the T3 response
- multiple provider instances remain isolated
- an unavailable or unauthenticated CLI produces a truthful snapshot

An opt-in real-CLI probe may verify version and authenticated model discovery without inference. Final manual validation must run a real Pi turn with streaming text and thinking, approve or reject a tool before execution, send an attachment, interrupt or steer the turn, resume or roll back the session, and verify no child process remains.

## Done when

- T3 detects the installed Pi CLI and shows only authenticated, usable models.
- The user can select a provider/model and supported thinking level.
- Prompts stream text, thinking, tool progress, context usage, and completion through normal T3 events.
- Restricted tools cannot execute before T3 approval.
- Attachments, interrupt, steering, resume, rollback, shutdown, and text generation work.
- Web, desktop, and mobile can select the Pi provider.
- The implementation is represented by exact downstream overlays and an active change record.

## Implemented shape

The downstream build registers `pi` as a normal multi-instance provider. Each T3 thread owns a
scoped `pi --mode rpc` process; provider status uses `pi --version` plus RPC model discovery, and
internal text-generation jobs use isolated no-session RPC processes. Pi remains responsible for its
authentication, models, project instructions, skills, prompts, and user extensions.

T3 embeds one small approval extension as server source and writes it to a scoped temporary `.mjs`
file when the adapter starts. That keeps desktop and server bundles self-contained without adding a
Pi SDK or maintaining a second packaged asset. Full-access sessions proceed directly; every other
runtime mode waits for T3's canonical approval response before Pi executes a tool.

All executable files are authored under `downstream/t3code/` and materialized into their normal T3
paths by `vp node downstream/tools/downstream.ts init`. The active file inventory and repeatable
validation commands live in the [Pi provider change record](../../changes/pi-provider.md).

## Deliberately excluded

- Embedding the Pi SDK or adding the old fork's Pi dependency
- Porting the old singleton manager
- Reproducing Pi's terminal UI
- Managing Pi authentication or secrets inside T3
- Disabling Pi's normal project resources
- Implementing every RPC command before T3's provider contract needs it
