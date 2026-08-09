# Downstream Compatibility

Compatibility is the ability to sync the integrated product to the current `upstream/main` commit without
losing downstream behavior or user data. It does not mean that every official client can safely
control every downstream server. The upstream
[connection runtime](../../docs/internals/connection-runtime.md),
[remote architecture](../../docs/internals/remote.md), and
[server update architecture](../../docs/internals/server-updates.md) define the base behavior.

## Baseline and Source Ownership

The fetched `upstream/main` commit is the integration input. Published nightly tags remain immutable
build-version metadata. `origin/main` is the accepted
downstream product, and normal Git commits record product source changes in their normal paths. Under
the current overlay model, every downstream-owned product file also has an exact counterpart
under `downstream/t3code/`, and `downstream.ts verify` rejects byte drift between the two copies.
Each active deviation has one record under `downstream/changes/` that explains why it exists, which
surfaces it affects, how to validate it, and when it can be removed. Bug records live in `Bugs/`.

During an upstream sync, resolve conflicts against the new upstream architecture. Do not preserve an
older interface through a compatibility layer solely to reduce the immediate merge diff. If upstream
now provides equivalent behavior, remove the downstream implementation and its change record in the
same sync.

When upstream changes a file also owned by the overlay, review the merged upstream file before
restoring the overlay. Update the normal file and its overlay counterpart together so the overlay does
not reintroduce the old upstream implementation.

## Contract Changes

Anything crossing the WebSocket boundary belongs in `packages/contracts` and must remain decodable
across expected client/server skew. Follow the existing upstream pattern:

- add optional fields or new tagged variants when an older peer can safely ignore them;
- advertise capabilities before a client sends a new command;
- keep unknown provider kinds and other open extension identifiers decodable;
- update the server producer, shared client runtime, web, desktop, and mobile consumers together;
- add forward-compatibility tests for old payloads and fallback behavior.

A downstream-only required field on an existing message is incompatible. A feature that cannot be
made additive needs an explicit minimum-version gate and a clear unavailable state on older peers.

## Client and Server Versions

Upstream clients compare their exact application version with the connected server and may offer an
exact `t3@<version>` update. The upstream user behavior is documented in
[Keeping T3 Code in Sync](../../docs/user/updating.md). A downstream version is not installable by
that command unless an exact matching server package has been published under the package name the
runtime uses.

Until downstream server distribution exists:

- bundled desktop servers may use the matching downstream version;
- external downstream servers must be installed from the same source checkout or another explicitly
  verified private distribution path;
- remote self-update and copied `npx t3@<downstream-version>` instructions are not a supported
  downstream update path;
- official hosted or mobile clients must not be relied on to preserve downstream-only behavior.

The release gate for remote support is a verified path that installs the exact downstream server,
runs its preflight, starts it, reconnects the client, and reports the same version. See
[Release and Distribution](release-and-distribution.md).

## Settings and Stored State

Settings schemas should use decoding defaults and preserve unknown downstream provider envelopes in
the same way upstream does. New settings must tolerate an older client that does not write them and a
newer client reading a document created before they existed.

Do not reuse official live state when testing a downstream change. Copy the database into the
worktree using the snapshot procedure in the root `AGENTS.md`, then exercise startup and the changed
behavior against that copy.

## Database Migrations

Upstream owns the increasing numeric migration sequence in
`apps/server/src/persistence/Migrations.ts`. A downstream migration must not take the next upstream
number or jump ahead in that same sequence: the first can collide with a later nightly, while the
second can cause later lower-numbered upstream migrations to be skipped.

Prefer additive events, settings, nullable columns supplied upstream, or derived projections when
they can express the feature. If a downstream schema change becomes necessary, stop and design a
separate downstream migration ledger and runner before shipping it. That design must prove:

1. upstream and downstream migrations have independent identities and ordering;
2. upgrading from the previous accepted downstream build preserves data;
3. rolling forward through a newer upstream migration still applies every migration once;
4. a failed trial follows the upstream snapshot-and-rollback boundary;
5. opening the same data with an older official or downstream build is either safe or explicitly
   blocked.

The upstream [server update architecture](../../docs/internals/server-updates.md) snapshots SQLite
for launcher-managed trial updates, but attachments and other state files are outside that rollback
boundary. Include those files in the compatibility review when a feature changes them.

## Upstream Compatibility Check

For each sync:

1. Fetch upstream, record the exact `upstream/main` commit, and confirm it is the merge target.
2. Review upstream changes overlapping every active change record and overlay-owned file.
3. Reconcile contracts, migrations, provider APIs, settings, and client capability checks before
   resolving presentation conflicts.
4. Use `$t3-sync` to orchestrate the complete update and review every overlapping
   full-file overlay before the skill applies `downstream.ts init`.
5. Deduplicate equivalent active-record commands, run every distinct focused validation, then run
   the downstream control-plane checks once.
6. Start the integrated build against copied real state when stored data or migrations changed.
7. Verify one matching client/server path for every supported connection mode affected by the roll.

A green compile with mismatched versions or untested stored data is not compatibility proof.
