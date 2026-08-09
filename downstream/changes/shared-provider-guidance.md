# Shared provider guidance

GitHub: #6

## Why

T3 authored developer instructions only for Codex. Pi, OpenCode, Hermes, Cursor, Grok, and Claude
retained their native harness prompts without one consistent T3-owned baseline explaining shared
T3 behavior, so provider behavior diverged as downstream providers were added (Codex was steered to
T3's collaborative preview tools while other providers with the same `t3-code` MCP tools were not).
This change introduces one provider-neutral guidance definition and delivers it through each
provider's strongest native channel, capability-gated so no agent is ever told to call `preview_*`
tools that were not attached to its session.

## Affected Surfaces

- New `apps/server/src/provider/T3Guidance.ts` builds provider-neutral guidance:
  a runtime-context section (always) and a collaborative-browser section (only when
  `hasPreviewTools`). Content is free of Codex protocol details so every channel is safe.
- Codex: `apps/server/src/provider/CodexDeveloperInstructions.ts` composes shared guidance into the
  developer instructions; `apps/server/src/provider/Layers/CodexSessionRuntime.ts` threads a
  `hasPreviewTools` flag (derived from `hasConfiguredMcpServer`) through `buildTurnStartParams`.
  Codex mode blocks, `request_user_input`, `update_plan`, `<proposed_plan>`, and runtime info are
  unchanged.
- Claude: `apps/server/src/provider/Layers/ClaudeAdapter.ts` appends shared guidance to the native
  `claude_code` system-prompt preset (`append`), with preview guidance gated on `t3-code` MCP
  presence.
- OpenCode: `apps/server/src/provider/Layers/OpenCodeAdapter.ts` sends shared guidance through the
  SDK's native `system` field on `promptAsync`, gated on `t3-code` MCP presence and non-external
  server. Native agent, project instructions, and parts are untouched.
- Pi: `apps/server/src/provider/Layers/PiAdapter.ts` appends shared guidance through Pi's native
  `--append-system-prompt` launch option at session spawn; it never replaces Pi's prompt, context
  files, skills, or extensions. Pi does not attach the `t3-code` MCP, so guidance is
  runtime-context only.
- Cursor / Grok / Hermes (ACP): explicit decision — ACP session and prompt requests have no
  system/developer-instruction field, so shared guidance is not sent. Capability-local guidance
  stays in the `t3-code` MCP preview tool descriptions; no adapter change, no user-message rewrite.
  Revisit if an ACP system channel appears.
- Web, desktop, mobile, contracts, persistence, and connection modes: no change. No new wire or
  stored-data shape; user message content is unchanged in T3 persistence and provider history.

## Overlay Files

- `apps/server/src/provider/CodexDeveloperInstructions.ts`
- `apps/server/src/provider/Layers/ClaudeAdapter.test.ts`
- `apps/server/src/provider/Layers/ClaudeAdapter.ts`
- `apps/server/src/provider/Layers/CursorAdapter.test.ts`
- `apps/server/src/provider/Layers/GrokAdapter.test.ts`
- `apps/server/src/provider/Layers/OpenCodeAdapter.ts`
- `apps/server/src/provider/T3Guidance.test.ts`
- `apps/server/src/provider/T3Guidance.ts`

## Validation

```bash
vp test run apps/server/src/provider/T3Guidance.test.ts \
  apps/server/src/provider/Layers/CodexSessionRuntime.test.ts \
  apps/server/src/provider/Layers/CodexAdapter.test.ts \
  apps/server/src/provider/Layers/ClaudeAdapter.test.ts \
  apps/server/src/provider/Layers/CursorAdapter.test.ts \
  apps/server/src/provider/Layers/GrokAdapter.test.ts \
  apps/server/src/provider/Layers/HermesAdapter.test.ts \
  apps/server/src/provider/Layers/OpenCodeAdapter.test.ts \
  apps/server/src/provider/Layers/PiAdapter.test.ts
(cd apps/server && vp run typecheck)
vp node downstream/tools/downstream.ts verify
git diff --check
```

Focused tests cover composition, capability gating (no `preview_*` guidance without the MCP),
Codex plan/default mode retention, Claude/OpenCode/Pi resumed-session delivery without duplicate
injection or user-content rewriting, and ACP request shapes for Cursor, Grok, and Hermes. Shared
guidance also contains no Codex protocol tokens.

## Removal Condition

Remove this change, the `PiAdapter` edits, and this record when upstream ships equivalent shared
provider guidance across all adapters. Keep the `--append-system-prompt` Pi delivery only if
upstream adopts it; otherwise drop it with the rest.
