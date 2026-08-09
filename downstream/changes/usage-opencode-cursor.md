# OpenCode and Cursor Usage History

## Why

The Usage page already aggregates complete provider-owned history for Claude Code and Codex.
OpenCode exposes the same per-response facts through its pinned SDK, and Cursor exposes them through
the signed-in desktop app's account usage endpoint. Adding those sources keeps Usage complete for
work performed outside T3 without replacing the existing transcript readers or page.

## Affected Surfaces

- `packages/contracts/src/usage.ts` admits OpenCode and Cursor and adds backward-compatible opaque
  source identities so remote servers and accounts can be de-duplicated across environments.
- `apps/server/src/usage/usageOpenCode.ts` pages OpenCode v2 sessions through the existing
  authenticated SDK client, accepts the current and pinned session envelopes, scans all projects,
  enforces the requested cutoff when newer servers ignore the pinned SDK's filter, and uses the
  same legacy-compatible message projection as OpenCode's stats command. If OpenCode cannot project
  one older session's messages, the reader preserves that session through OpenCode's own aggregate
  tokens, cost, model, and update time instead of failing the complete window.
- `apps/server/src/usage/usageCursor.ts` reads Cursor's app database read-only, derives the dashboard
  session in memory, pages account usage with completeness checks, and maps provider-reported tokens
  and raw token cost into `UsageRecord`. Cursor's empty success object is treated as zero usage.
- `apps/server/src/usage/UsageService.ts` upserts both readers beside the existing Claude and Codex
  scans. A missing or failed new source remains provider-local and does not erase successful usage.
- `apps/server/src/server.ts` provides the existing OpenCode runtime to the Usage layer.
- `apps/server/src/usage/usageAggregation.ts` carries an opaque source identity into new-provider
  buckets so separate OpenCode servers remain independently de-duplicable.
- `packages/shared/src/usageMerge.ts` claims remote account and server sources by opaque identity and
  ignores failed claims when another environment can read the same source successfully. Upstream
  moved the shared merge helper out of the web package; the downstream source-identity behavior now
  follows that shared boundary so web and mobile use one implementation.
- `apps/web/src/components/usage/` adds existing Cursor and OpenCode marks, labels, colors, chart
  bands, daily columns, and loading placeholders to the current Usage presentation.
- `apps/mobile/src/features/usage/usageProviders.ts` extends upstream's mobile Usage dashboard with
  the same Cursor and OpenCode labels, colors, and provider order required by the downstream
  contract.
- Focused contract, server, merge, and chart tests live beside the affected code.

## Overlay Files

- `apps/server/src/usage/UsageService.ts`
- `apps/server/src/server.ts`
- `apps/server/src/usage/usageAggregation.ts`
- `apps/server/src/usage/usageCursor.test.ts`
- `apps/server/src/usage/usageCursor.ts`
- `apps/server/src/usage/usageOpenCode.test.ts`
- `apps/server/src/usage/usageOpenCode.ts`
- `apps/mobile/src/features/usage/usageProviders.ts`
- `apps/web/src/components/usage/UsagePage.tsx`
- `apps/web/src/components/usage/UsageProviderChart.test.ts`
- `apps/web/src/components/usage/usageProviders.ts`
- `packages/shared/src/usageMerge.test.ts`
- `packages/shared/src/usageMerge.ts`
- `packages/contracts/src/usage.test.ts`
- `packages/contracts/src/usage.ts`

## Validation

```bash
vp test run packages/contracts/src/usage.test.ts apps/server/src/usage/usageOpenCode.test.ts apps/server/src/usage/usageCursor.test.ts apps/server/src/usage/usageAggregation.test.ts packages/shared/src/usageMerge.test.ts apps/web/src/components/usage/UsageProviderChart.test.ts
vp run --filter @t3tools/contracts typecheck
vp run --filter t3 typecheck
vp run --filter @t3tools/web typecheck
vp run --filter @t3tools/mobile typecheck
vp node downstream/tools/downstream.test.ts
vp node downstream/tools/downstream.ts verify
git diff --check
```

OpenCode coverage must prove completed assistant messages retain model, token categories, reasoning,
cost, session, and message identity across both response envelopes, including token-bearing free
models at zero reported cost, plus aggregate fallback for a session whose message projection fails.
Cursor coverage must prove read-only app authentication, empty-window success, boundary-overlap
reconciliation, provider-reported cost mapping, malformed-event isolation, and fail-closed
pagination.

## Removal Condition

Remove this deviation, its overlay files, and this record when upstream Usage reads equivalent
OpenCode SDK history and Cursor account history with bounded pagination, provider-local failure,
and multi-environment source de-duplication. If upstream ships only one source, retire only that
provider's implementation and reconcile the shared contract and merge changes instead of keeping a
duplicate path.
