# Mid-Thread Provider and Model Switching

Status: planned
Priority: unassigned
Reference: [Provider architecture](../providers.md)

## Goal

Allow a user to choose a different model or configured provider instance between turns without
starting a new T3 thread. The same thread, workspace, visible transcript, checkpoints, runtime mode,
and interaction mode must continue to apply after the switch.

Provider-native resume state remains an optimization, not the owner of conversation history. When
the target cannot consume the current provider's resume cursor, T3 must start a fresh target session
and hand it the canonical T3 transcript with the next user message.

This plan uses “mid-thread” to mean between settled turns. Switching away from a provider while its
turn is running, starting, waiting for approval, or waiting for structured user input remains
disallowed because doing so would abandon live work and callbacks.

## Current Behavior

The existing contracts already carry most of the required information:

- `OrchestrationThread.modelSelection` records the thread's current selection.
- `thread.turn.start` can carry a different `modelSelection` for the next turn.
- `ProviderSession.resumeCursor` and `provider_session_runtime.resume_cursor_json` hold opaque native
  continuation state separately from the T3 transcript.
- T3 persists canonical user, assistant, and system messages independently of every provider.
- Web and mobile already stage model selection in the composer and send that selection with the
  turn.

The lock is enforced in two places:

- `ProviderCommandReactor.ensureSessionForThread` rejects a requested instance when its driver or
  continuation identity differs from the session already associated with the thread.
- Web filters the model picker to the locked driver and continuation group, while mobile filters the
  settings sheet to the current provider instance.

Same-session model changes already work when an adapter declares `sessionModelSwitch: "in-session"`.
Compatible instances of the same provider can restart with the same native cursor. The missing path
is a fresh native session hydrated from T3 history.

## Core Decision

Choose continuation mode at the turn boundary:

1. **Reuse the active session** when the provider instance can apply the selected model in session.
2. **Resume natively** when a session restart is required and the current and target instances share
   a continuation key.
3. **Hand off canonically** for a different driver, an incompatible provider instance, or a model
   change whose provider requires a new native conversation.

Canonical handoff starts a fresh target session without the old cursor, then sends one provider-only
input containing the prior T3 transcript followed by the real current user request. The persisted
user message remains unchanged, so switching does not expose synthetic messages in the chat or
duplicate the handoff when the thread later switches again.

Do not add a provider-specific import API. The current adapters all accept text input, while their
native history formats differ. A deterministic text handoff works across every existing and future
adapter without widening `ProviderAdapter` or teaching orchestration about provider protocols.

## Canonical Handoff Format

Build the handoff on the server from `ProjectionSnapshotQuery.getThreadDetailById`, immediately
before `ProviderService.sendTurn`:

- Select only complete messages before the triggering `messageId`; this prevents the current user
  message from appearing once in history and again as the active request.
- Preserve message order and role, and include attachment IDs, names, and MIME types in the
  transcript.
- Tell the target that it is continuing the same T3 thread and workspace, that the transcript is
  prior conversation, and that it should continue from the final current request without repeating
  completed work.
- Encode transcript records as JSON so message contents cannot break role or message boundaries.
- Pass retained historical image attachments to the target when attachment slots remain, with the
  current turn's attachments taking priority.
- Never persist the rendered handoff text as a T3 message, activity payload, log field, or analytics
  value.

Use the existing `PROVIDER_SEND_TURN_MAX_INPUT_CHARS` and attachment limits. Include the full history
when it fits. When it does not, keep a bounded portion of the first user request plus the newest
complete messages that fit, and add an explicit omission marker. Do not add an LLM summarization
step in the first implementation; it would introduce another provider dependency, cost, latency,
and a second failure path before every switch.

The handoff intentionally excludes hidden reasoning, raw provider events, tool logs, approval
callbacks, and thread activities. Those streams are provider-shaped and can be very large. The new
provider receives the user-visible conversation and sees the same current filesystem, which is the
durable result of prior tool work.

## Server Lifecycle

### 1. Classify the requested continuation

Refactor the existing session decision in `ProviderCommandReactor` into one small pure classifier
that returns `reuse`, `native-resume`, or `canonical-handoff`. Reuse the existing adapter capability,
driver kind, continuation key, active session, and requested `ModelSelection`; do not add another
provider capability model.

Reject `canonical-handoff` while the current orchestration session is `starting` or `running`, or
while provider callbacks remain actionable. This server invariant protects web, mobile, remote, and
older clients even if their picker state is stale.

### 2. Start the target without foreign state

For `canonical-handoff`, call `ProviderService.startSession` for the target instance without a resume
cursor. Start the target before stopping the settled old session, so a target startup failure leaves
the prior session recoverable. After the target starts, let the existing stale-session cleanup stop
the old adapter session for that T3 thread.

The starting session projected to clients must name the target provider and instance. The current
code prefers the active session identity while a restart is pending, which would briefly present the
old provider during a handoff.

### 3. Reset persisted native identity atomically

Change `ProviderSessionDirectory.upsert` so a provider or provider-instance identity change does not
inherit the previous binding's cursor or provider-specific runtime payload. A target session may
write its own cursor and payload, but an absent target cursor must clear the old one instead of
preserving it.

This is required even though `startSession` currently refuses to pass a persisted cursor to a
different instance. Without the reset, a later recovery can observe stale foreign state after the
binding has already been relabeled as the target provider.

### 4. Send the first target turn

For `canonical-handoff`, render the canonical history and prepend it only to the provider input sent
for this turn. Keep the original text in `thread.message-sent`, client state, search, copy, and
checkpoint correlation.

After target session startup succeeds, update the thread's current `modelSelection` through the
existing metadata path and append one informational activity such as “Continued with Claude Opus 5”
with source and target instance/model metadata. Do not add model provenance to every message or a
new history table in the first implementation.

If target startup fails, retain the old live binding and report the existing
`provider.turn.start.failed` activity. The selected target can remain staged for retry, but the
session identity shown in the thread must continue to reflect the provider that is actually bound.

## Checkpoints and Reverts

Provider-native rollback currently assumes that every T3 checkpoint belongs to the one native
conversation bound to the thread. That assumption stops being valid after a handoff.

Record the checkpoint turn count at which a canonical session begins in the provider runtime
payload. On revert:

- If the target checkpoint is within the current native segment, keep the existing native rollback
  and T3 projection trimming.
- If the target checkpoint predates the current native segment, restore the filesystem and trim the
  canonical T3 history as today, then stop and discard the current native session binding instead of
  asking it to roll back turns it never saw.
- The next turn starts fresh and uses the same canonical handoff path from the reverted T3 history.
  The currently selected model remains selected unless the user changes it.

Expose one narrow provider-service operation that stops the active session and deletes its runtime
binding. Reuse the existing persistence repository deletion; do not add a second session store.
This also prevents a discarded post-revert cursor from resurrecting messages that T3 has removed.

## Client Changes

### Web and desktop

- Remove the driver and continuation-group filtering from the started-thread model picker.
- Keep unavailable providers disabled using the existing provider snapshots.
- Disable cross-provider choices while the thread has live work or actionable callbacks, with a
  short “Available after this turn finishes” reason.
- Keep the current same-provider model restrictions only until the server canonical-handoff path is
  available; providers that require a new native thread should then use handoff instead of telling
  the user to start a new T3 thread.
- Continue staging the selected model in the composer and sending it through the existing
  `thread.meta.update` and `thread.turn.start` flow.

Desktop inherits the web implementation and needs no Electron IPC change.

### Mobile

- Pass all configured provider groups to `ThreadSettingsSheet` instead of filtering to the current
  instance.
- Apply the same busy-state disabling and explanation as web.
- Keep the existing outbox snapshot of `modelSelection`. The outbox already waits for a thread to be
  idle, so a queued message can safely carry the provider selection that should apply when it is
  delivered.

No new client/server command is required. Remote, relay, and tunnel connections use the existing
typed `thread.turn.start` command, so the behavior remains server-owned and consistent across
clients.

## Expected Implementation Surfaces

- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` and focused tests
- `apps/server/src/provider/Layers/ProviderSessionDirectory.ts` and focused tests
- `apps/server/src/provider/Layers/ProviderService.ts` plus its service interface and focused tests
- `apps/server/src/orchestration/Layers/CheckpointReactor.ts` and focused revert tests
- web model-lock logic, picker filtering, and focused component/logic tests
- mobile composer/settings provider filtering and focused tests
- user provider documentation that currently says an existing thread is provider-bound
- `downstream/t3code/` overlays and one `downstream/changes/` record for every fork-owned source or
  test file if this remains downstream-only

Exact filenames should be rechecked against the current nightly before implementation. No database
migration is expected for the core switch because model selection, messages, and opaque runtime
payload already exist.

## Validation

Focused automated coverage must prove:

- same instance plus supported model change reuses the active session
- compatible instances resume with the native cursor and do not receive a synthetic transcript
- different drivers start the target without the source cursor and receive prior T3 history exactly
  once
- incompatible instances of the same driver use canonical handoff
- providers requiring a new native conversation can change models in the same T3 thread
- the handoff excludes the triggering message from history, preserves role order, stays within input
  and attachment limits, and reports truncation deterministically
- historical handoff text is absent from the projected messages and activities
- a target startup failure leaves the previous provider binding intact
- switching is rejected while a turn or provider callback is live
- identity changes clear stale resume cursors and provider-specific runtime payload
- reverting within the current native segment uses native rollback
- reverting across a handoff boundary discards the current native binding and the next turn hydrates
  from the reverted T3 history
- web and mobile offer all available providers after a thread starts and disable them only during
  live work
- mobile outbox delivery preserves the model selection captured for each queued turn

After focused tests and typechecks, perform one integrated web pass and one mobile pass with explicit
permission. Exercise Codex to Claude and back again in one thread, including an image in prior
history, a failed target startup, a successful continuation, and a checkpoint revert across the
switch boundary. Confirm the visible transcript never contains the synthetic handoff block and each
provider sees the current workspace state.

## Done When

- A settled T3 thread can switch between any two configured provider instances from web, desktop,
  or mobile without creating a new thread.
- The target responds with the relevant prior visible conversation and current filesystem context.
- Native continuation is still used when compatible and foreign cursors are never crossed.
- Switching twice does not duplicate synthetic history in the T3 transcript or the next handoff.
- Failed switches, server restarts, queued mobile turns, and checkpoint reverts leave one truthful
  provider binding and a recoverable thread.
- Existing clients that do not expose the unlocked picker continue to work with the unchanged turn
  command contract.

## Deliberately Excluded

- Switching during an active turn or abandoning pending provider callbacks
- Translating provider-native hidden reasoning, tool events, or approval state
- Importing or rewriting one provider's native transcript into another provider's storage
- LLM-generated conversation summaries in the switching path
- Keeping multiple live provider sessions attached to one T3 thread
- Per-message model badges or a new model-provenance database schema
