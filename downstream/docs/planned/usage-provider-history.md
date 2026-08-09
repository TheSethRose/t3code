# Provider History in Usage

Status: planned
Priority: unassigned
Reference: [Provider architecture](../providers.md)

## Goal

Extend the existing Usage page from Claude Code and Codex to every T3 provider that can supply
complete, durable token history with honest cost provenance. Preserve the current contract,
transcript scanning, scan cache, aggregation, multi-environment de-duplication, and web page. New
providers are additive sources feeding the same `UsageRecord` and `UsageSummary` pipeline.

The page remains a historical answer to “what tokens did these agents process, by day, provider,
and model?” It does not become a general subscription-quota dashboard. Rolling limits, credit
balances, plan resets, and browser-cookie account scraping are different data with different scope;
mixing them into the existing totals would make account-wide quotas look comparable to local
transcript history when they are not.

## Current Behavior

- `packages/contracts/src/usage.ts` admits only `"claude"` and `"codex"`, and defines daily token
  buckets, raw API-equivalent cost, pricing provenance, physical-source fingerprints, scan status,
  and the versioned summary returned by each environment.
- `apps/server/src/usage/UsageService.ts` resolves the configured Claude and Codex homes, scans
  their JSONL histories, prices records through the existing LiteLLM table, and caches parsed files
  by path, provider, size, and modification time.
- `usageTranscripts.ts` normalizes provider records into one `UsageRecord`. The aggregator and web
  merge logic are already provider-neutral once a record has crossed that boundary.
- The web page has a small closed presentation map for provider order, labels, colors, and icons.
  The chart, provider totals, model table, daily table, and multi-environment merge all consume the
  existing buckets.
- The downstream build adds Pi and Hermes and retains the upstream Cursor, Grok, and OpenCode
  drivers, but none currently contributes durable history to Usage.

## Source Rules

- A provider joins the page only when it has token-cost history. Providers without that capability
  are omitted instead of appearing as empty subscriptions.
- Provider acquisition stays provider-owned: local transcript, local SQLite, CLI/RPC, or remote
  API are separate sources whose scope and fallback order are explicit.
- A failed refresh retains the last successful result, while a provider or account configuration
  change invalidates obsolete data.
- Coverage is stated honestly when the available source covers less than the selected window.
- T3 reuses its existing provider configuration, authentication, remote-environment, aggregation,
  caching, and UI boundaries. Usage does not add browser-cookie import, Keychain storage, web
  scraping, or a second provider model.

## Core Decision

Upsert one durable provider history source at a time. A provider joins Usage only when its source
can produce the existing normalized facts:

- timestamp and stable session identity
- actual model identity
- non-cumulative per-response token counts, or cumulative counts with a reliable delta rule
- input/cache-write/cache-read/output/reasoning separation when the provider exposes it
- a stable de-duplication key
- provider-reported cost, or enough model identity for LiteLLM pricing
- a source scope that can be fingerprinted and explained as local-device, remote-environment, or
  account-wide

Missing token categories may map to zero only when the provider truly does not report them. An
unknown field must not be guessed from context-window occupancy, quota percentage, turn count, or
file size. Known tokens with an unknown rate remain visible as unpriced, matching current behavior.

The current Claude and Codex code remains in place. For the first new JSONL source, add its resolver
and parser beside the existing ones and reuse `UsageRecord`, `UsageAggregator`, `UsageScanCache`,
and `UsageSource`. Extract a tiny shared source helper only when a second implementation needs the
same branching. Do not introduce a new plugin framework, provider package API, database, or client
RPC for this work.

## Provider Plan

### 1. OpenCode

OpenCode is the first implementation. The pinned `@opencode-ai/sdk` already exposes the complete
history path T3 needs:

- `client.v2.session.list` returns ordered, cursor-paginated sessions and accepts a start timestamp.
- `client.v2.session.messages` returns cursor-paginated messages for each session.
- Every assistant message carries `id`, `sessionID`, created/completed timestamps, `providerID`,
  `modelID`, provider-reported `cost`, and input/output/reasoning/cache-read/cache-write tokens.
- T3 already creates an authenticated, directory-aware SDK client and uses `session.messages` for
  thread history and rollback.

Implementation order:

1. Add an OpenCode usage reader beside the existing OpenCode runtime helpers. Reuse
   `connectToOpenCodeServer`, `createOpenCodeSdkClient`, `runOpenCodeSdk`, configured `serverUrl`,
   password, environment, and managed-process lifecycle; do not create another SDK client path.
2. Page `v2.session.list` newest-first with the requested window start, then page each in-window
   session's messages. Stop only on the SDK cursor boundary; do not publish a partial source after a
   page failure.
3. Emit one `UsageRecord` per completed assistant message. Use the message ID as the de-duplication
   key, the created timestamp for day bucketing, the session ID for distinct-session totals, the
   reported token fields directly, and `cost` as provider-reported cost.
4. Preserve the real upstream provider/model identity in the model label. The Usage provider is
   OpenCode because it is the harness whose durable history is scanned; the model remains the
   provider-qualified model used by the session.
5. Fingerprint the source by canonical server identity plus provider instance. Managed-local
   instances on one environment share the same underlying OpenCode store and must count once;
   different external server URLs remain distinct.

Do not read OpenCode's SQLite database in this implementation. The SDK already exposes richer token
history and works for managed-local and external modes without binding T3 to a private storage
schema. Subscription percentages and web workspace quotas stay excluded.

### 2. Pi

The Pi adapter's `get_session_stats` response currently feeds the active context-window indicator.
That is cumulative live context occupancy, not historical processed-token usage, so it cannot be
inserted into Usage directly.

Inspect Pi's provider-owned session file returned by `get_state.sessionFile` and capture fixtures
from the minimum supported Pi version. If assistant records contain per-response timestamp, model,
session ID, token usage, and optional cost, add a streaming Pi parser to the existing transcript
reader and resolve Pi's actual session root from the CLI/runtime rather than hard-coding an assumed
home. Reuse the current JSONL scan cache when the files are append-only.

If Pi stores only current context totals, leave it unsupported until Pi exposes durable per-turn
usage. Do not persist a second T3-owned ledger from adapter events: it would omit Pi work performed
outside T3 and violate the page's current completeness model.

### 3. Hermes

ACP defines `usage_update`, but the Hermes adapter does not currently turn that live notification
into durable historical Usage data. First confirm that Hermes 0.20+ emits the update with model and
per-turn token fields, then locate a Hermes-owned history API or persisted session format carrying
the same data.

If durable history exists, parse that provider-owned source into `UsageRecord`. If it does not,
Hermes remains absent from Usage. Do not build a T3-only usage ledger from ACP notifications because
replayed, interrupted, externally-run, and pre-integration Hermes turns would produce misleading
coverage.

### 4. Cursor

Cursor is the second implementation. Its account usage endpoint returns the exact fields required
by T3: event timestamp, model, input/output/cache-write/cache-read tokens, vendor-list token cost,
and plan-metered cost. T3 can authenticate without browser-cookie import by reading the signed-in
Cursor application's existing local auth record:

- macOS: `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`
- Linux: `$XDG_CONFIG_HOME/Cursor/User/globalStorage/state.vscdb`
- key: `cursorAuth/accessToken`
- derive `WorkosCursorSessionToken=<jwt-sub>::<access-token>` using the JWT subject already present
  in the token; never persist or return the token or derived cookie

Implementation order:

1. Add a read-only Cursor app-auth resolver in the Cursor provider boundary. Missing Cursor.app
   state is a missing Usage source, not a provider failure; `cursor-agent` remains the conversation
   runtime and no login behavior changes.
2. POST the selected local-day window to
   `https://cursor.com/api/dashboard/get-filtered-usage-events` using the derived session cookie,
   matching Cursor's required origin and content headers.
3. Page 1,000 events at a time with a hard 200-page cap. Require a short or empty terminal page and
   reconcile only exact adjacent-page overlap against the API's authoritative event count. If the
   cap, count, or page sequence cannot prove completeness, fail the Cursor source instead of
   publishing a partial total.
4. Normalize each event into `UsageRecord`: map input/output/cache-write/cache-read directly,
   preserve the model, use `tokenUsage.totalCents / 100` as provider-reported raw API-equivalent
   cost, and derive a stable de-duplication key from the complete event payload because the endpoint
   exposes no event ID.
5. Defer `chargedCents`/Cursor-metered deductions. The current Usage contract has one monetary
   measure and explicitly presents raw API-equivalent cost; mixing plan deductions into that field
   would change the meaning of existing Claude and Codex totals.
6. Mark Cursor as account-wide and fingerprint it with a one-way hash of the resolved account
   identity. Multiple T3 environments signed into the same Cursor account must count the remote
   history once, while different accounts remain separate.

Browser-cookie import, stored browser sessions, account switching, and Cursor login UI remain out
of scope. Cursor history is available when the signed-in Cursor app state exists on that
environment.

### 5. Grok

Do not add Grok to the main Usage totals from its current sources. `x.ai/billing` is a quota window,
and `~/.grok/sessions/**/signals.json` contains context and compaction signals that are not reliable
per-response processed-token totals. They can support provider diagnostics later, but they cannot
satisfy the existing Usage contract.

Revisit Grok when the CLI exposes durable per-turn token history or a bounded history API with
daily model usage. At that point, use `GROK_HOME` and the configured binary/environment already
owned by the Grok driver; do not introduce browser-cookie fallback for historical Usage.

## Additive Contract and UI Changes

For each provider that passes its history gate:

- Add its usage identity to `UsageProviderKind` and bump `USAGE_CONTRACT_VERSION` once for the
  implementation batch. Existing Claude/Codex payloads remain valid.
- Extend `UsageSourceFingerprint` with a source scope and opaque source identity. Existing
  filesystem sources default to `localFilesystem` and keep their current host/path/volume key.
  OpenCode external servers use `remoteServer`; Cursor uses `remoteAccount`. Hash canonical server
  and account identities before putting them on the wire, and de-duplicate remote scopes without
  the environment host ID so the same account or server connected through two environments counts
  once.
- Add only the provider's label, icon, color, and order to `usageProviders.ts`. Reuse the existing
  provider icon assets. The chart, summary, model rows, daily columns, skeleton, and legend already
  iterate the shared provider order.
- Render only providers represented by returned buckets in summary rows. Static table headers may
  use the supported order, but unsupported configured providers must not appear as zero-usage
  claims.
- Keep raw API-equivalent USD as the only combined monetary total. Do not combine currencies,
  subscription percentages, credits, or metered plan deductions with it.
- Extend source diagnostics so an enabled but unsupported mode can say why it is absent, such as
  “OpenCode history is on an external server that does not expose usage history.” Do not turn an
  unsupported provider into an environment-wide read failure.

No new Usage route, page, chart library, state store, WebSocket method, or mobile surface is needed.
Desktop inherits web. Mobile does not currently expose the Usage page and remains out of scope.

## Failure and Coverage Rules

- One provider source failing must not discard successful sources from the same environment. Return
  a failed or partial `UsageSource` for that provider and keep the other buckets.
- A failed refresh should continue showing the last successful environment summary through the
  existing query cache when possible, with stale/partial coverage visible. Do not replace known
  totals with zero because one source became temporarily unreadable.
- History readers must be bounded by the selected day window. Cursor's paginated API must fail
  rather than publish partial totals when a safety cap is reached before the provider's reported
  event count is satisfied.
- Provider configuration changes that alter home path, server URL, account, or credentials must
  change the source fingerprint/cache key so prior-account data cannot survive under the new
  configuration.
- Never send raw transcripts, SQLite rows, cookies, credentials, or provider-native messages over
  the WebSocket. Environments continue returning only aggregated buckets and bounded diagnostics.

## Expected Implementation Surfaces

- `packages/contracts/src/usage.ts` and focused contract tests
- `apps/server/src/usage/` provider resolver/parser additions and focused fixtures
- `apps/web/src/components/usage/usageProviders.ts` plus chart/page tests
- existing provider runtime helpers only when needed to reuse an authenticated SDK or resolve the
  provider-owned history location
- byte-identical downstream overlays and one active change record for every downstream-owned source
  or test file

Exact source files are chosen per provider after its history gate; do not reserve empty provider
folders or add unsupported provider cases in advance.

## Validation

For each admitted provider, focused automated coverage must prove:

- one real fixture maps timestamp, session, model, token categories, reasoning subset, and cost
  provenance correctly
- cumulative records are converted to deltas without negative or repeated totals
- duplicate records and resumed sessions count once
- malformed and truncated records are skipped without poisoning valid files
- missing, partial, failed, and unsupported sources preserve successful provider buckets
- scan-cache entries cannot cross provider, home, server, or account boundaries
- the selected local-calendar day window is honored across DST boundaries
- multi-environment de-duplication drops the same physical source once but keeps distinct machines
  and external servers
- the provider appears in the summary, chart, model breakdown, daily table, legend, and loading
  state with the same totals
- Claude and Codex fixtures and merged totals are unchanged

Run only focused checks for touched packages and files, followed by the downstream overlay check:

```bash
vp test run apps/server/src/usage/<touched-tests>
vp test run apps/web/src/usage/usageMerge.test.ts apps/web/src/components/usage/<touched-tests>
vp run --filter @t3tools/contracts typecheck
vp run --filter t3 typecheck
vp run --filter @t3tools/web typecheck
vp node downstream/tools/downstream.ts verify
```

The integrated proof uses a copied worktree data set or provider-owned test fixture, never the live
T3 database. For each provider, compare the Usage totals against the provider's own session/API
records for the same day window, then confirm an environment without that provider reports partial
or missing coverage without affecting other providers.

## Done When

- Claude and Codex behavior is unchanged.
- Every newly displayed provider has complete durable history for its supported source mode and an
  honest scope label.
- OpenCode is attempted first; Pi and Hermes join only after their durable formats are proven;
  Cursor follows through its read-only app-auth source; Grok stays excluded until it exposes real
  history.
- Unsupported providers do not appear as zero usage, and one failed provider does not erase the
  environment's valid totals.
- All new implementation remains an independently removable downstream upsert with mirrored files,
  focused tests, and a removal condition for equivalent upstream support.

## Deliberately Excluded

- Replacing `UsageService`, `UsageSummary`, `UsageAggregator`, the scan cache, merge logic, or the
  Usage page
- Browser-cookie import, Keychain access, web scraping, or provider login UI
- Subscription quota bars, reset countdowns, credit balances, account identity, or status polling
- A T3-owned event ledger that counts only turns run through T3
- Guessed token totals derived from context occupancy, compaction counters, quota percentages, or
  turn counts
- A generic provider plugin framework before two real new history sources demonstrate the same
  extension seam
