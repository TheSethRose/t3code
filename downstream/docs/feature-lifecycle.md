# Downstream Feature Lifecycle

A downstream feature is one independently removable deviation from the accepted upstream nightly.
Executable code and tests stay in their normal `apps/`, `packages/`, `scripts/`, or infrastructure
paths. Every downstream-owned file has an exact counterpart at the same relative path under
`downstream/t3code/`. Its maintenance record lives at `downstream/changes/<slug>.md` and exists only
while the deviation remains active.

The upstream [architecture overview](../../docs/internals/overview.md),
[workspace layout](../../docs/internals/workspace-layout.md), and
[CI gates](../../docs/internals/ci.md) define the base repository conventions. This guide adds the
downstream lifecycle.

## 1. Define the Change

Start from downstream `main` on one short-lived `feat/*` or `fix/*` branch. Before implementation,
write the change record with these sections:

```markdown
# Change name

## Why

## Affected Surfaces

## Overlay Files

## Validation

## Removal Condition
```

`Why` states the user-visible or operational result. `Affected Surfaces` names the normal source and
test paths, their overlay counterparts, and the wire, settings, data, and mixed-version behavior that
must be reviewed during a nightly roll. `Validation` contains exact runnable commands and the
expected proof. `Removal Condition` names the upstream change or product decision that makes the
deviation unnecessary.

Add an exact `## Overlay Files` section with one backtick-wrapped, repository-relative path per
bullet. Every overlay file except `downstream/t3code/AGENTS.md` has exactly one active owner. The
verifier rejects missing, duplicate, or stale ownership.

## 2. Walk Every Surface

Make an explicit decision for each applicable row:

| Area          | Required decision                                                                  |
| ------------- | ---------------------------------------------------------------------------------- |
| Entry points  | Chat, Settings, command palette, and keybindings that can reach the behavior.      |
| Clients       | Local web, hosted downstream web, desktop shell, iOS, and Android.                 |
| Contracts     | Additive wire shape, capability advertisement, and old-peer fallback.              |
| Server        | Command, event, projection, side effect, receipt, and lifecycle behavior.          |
| Providers     | Codex, Claude, Cursor, Grok, OpenCode, and unknown downstream drivers.             |
| Reverse state | How the user leaves, undoes, disables, retries, or observes the state.             |
| Connections   | Local, direct remote, Tailscale, relay, SSH, multi-device, and reconnect behavior. |
| Data          | Settings, SQLite, files, migration policy, rollback, and downgrade behavior.       |
| Docs          | User-visible behavior, internals, operations, and this downstream record.          |

Put shared non-visual client behavior in `packages/client-runtime`, wire schemas in
`packages/contracts`, provider-specific complexity at the adapter boundary, and executable product
changes in the normal upstream tree. Mirror each downstream-owned file under `downstream/t3code/` in
the same commit series. A surface may be marked unsupported when the record explains the user-visible
fallback.

## 3. Implement in Dependency Order

For a cross-surface feature, use this order:

1. Add or extend contracts with backward-compatible decoding and capability checks.
2. Implement server decisions, events, projections, adapters, and side effects with focused tests.
3. Add shared client state and connection behavior.
4. Implement web and desktop behavior, including every reachable entry point.
5. Implement mobile behavior or a deliberate unavailable state.
6. Update user, internal, operational, and downstream docs where the behavior belongs.

Keep the change in one coherent commit or short commit series. Do not combine unrelated cleanup with
the deviation; smaller ownership makes nightly conflict review and later removal cheaper.

## 4. Validate the Real Boundary

Run the smallest focused tests first, followed by targeted typechecks for the changed packages. Add
the downstream control-plane checks:

```bash
vp node --test downstream/tools/downstream.test.ts
vp exec tsgo -p downstream/tools/tsconfig.json --noEmit
vp node downstream/tools/downstream.ts verify
```

Backend behavior needs a focused regression test. User-visible frontend behavior needs one
integrated pass in the applicable real client when requested. Provider behavior needs proof through
the actual provider runtime for installation, authentication, one completed turn, streaming,
interruption, continuation, and shutdown. A compile or mocked adapter test does not prove those
installed states.

Finish with `vp run build:desktop` when the integrated desktop/server/web pipeline is affected. Do
not replace focused validation with repo-wide checks outside CI.

## 5. Roll Forward

During each nightly roll, use `$merge-t3code-downstream` after the upstream merge and before
`downstream.ts init`. Compare upstream changes with every active record's files and affected
surfaces, resolve against current upstream architecture, and update the normal file, overlay
counterpart, and record together. Run init only after both copies contain the reviewed result, then
rerun the exact validation. Follow
[Compatibility](compatibility.md) for contracts, stored data, and mixed versions.

If upstream changes the extension point, adapt the downstream feature to it. Do not add a permanent
wrapper around an obsolete upstream interface unless the feature has an independent compatibility
requirement that justifies it.

## 6. Remove the Deviation

When upstream provides equivalent behavior, restore the upstream implementation and remove the
overlay counterparts and change record in the same roll. The copy-only overlay cannot preserve a
downstream deletion of an upstream-tracked file; add and test an explicit tombstone mechanism before
allowing that kind of deviation. Keep a regression test only when it still protects behavior
upstream does not cover. Git history retains the old rationale, so inactive change records do not
need an archive folder.
