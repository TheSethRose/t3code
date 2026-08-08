# Downstream Maintenance

## Scope

This directory is the downstream-owned control layer. It contains coordination records, downstream agent instructions, and maintenance tooling; executable product source and regression tests stay in their normal repository paths.

Read the repository-root `AGENTS.md`, `downstream/README.md`, and `downstream/docs/README.md` before
changing anything here. The upstream `docs/` tree remains authoritative for shared T3 Code behavior;
the downstream docs define only fork-specific boundaries, compatibility, release, and maintenance
policy.

## Documentation

- Read `docs/product-boundary.md` before changing application identity, supported clients, remote
  behavior, or upstream-service use.
- Read `docs/compatibility.md` before changing contracts, settings, stored data, migrations, or
  client/server version behavior.
- Follow `docs/feature-lifecycle.md` for every fork-only feature or fix.
- Read `docs/release-and-distribution.md` before changing builds, artifacts, signing, publishing, or
  update channels.
- Read `docs/services-and-security.md` before changing pairing, authentication, hosted clients,
  relays, credentials, or deployment workflows.
- Read `docs/providers.md` before changing a provider driver, provider SDK integration, runtime,
  snapshot, adapter, or text-generation implementation.
- Update the applicable downstream document during the same change or nightly roll when its facts or
  policy change. Link to upstream docs instead of copying shared architecture into this directory.

## Active Changes

Create `changes/<slug>.md` in the same commit series that introduces fork-only behavior. Keep the record short and include:

- why the deviation exists;
- affected contracts, providers, clients, runtime paths, or source areas;
- exact normal-path files owned under `## Overlay Files`;
- focused validation required after an upstream roll;
- the upstream event or other condition that allows removal.

Update a record when its behavior or validation changes. Delete it with the redundant implementation when upstream absorbs the deviation; Git history is the archive.

## Integration Rules

- `origin/main` is the tested downstream product branch.
- Published upstream nightly tags are immutable integration inputs.
- Run `vp node downstream/tools/downstream.ts roll` from a clean `main`; do not reproduce its fetch, tag-selection, or branch setup by hand unless repairing the tool.
- After the upstream merge, use `$merge-t3code-downstream` before `downstream.ts init` to review every
  upstream change that overlaps a full-file overlay and synchronize the normal path with its overlay.
- Nightly rolls happen on temporary `sync/nightly-<date>.<run>` branches and merge into `main` only after validation.
- Fork-only features and fixes use short-lived topic branches and remain independently removable.
- Each fork-only feature follows `docs/feature-lifecycle.md` and records every applicable client,
  provider, contract, reverse-state, connection, data, and documentation decision.
- Runtime code and regression tests must live in their normal T3 paths and have byte-identical copies
  at the same relative paths under `downstream/t3code/`. The active `changes/<slug>.md` record is
  what makes restoration and review intentional during every nightly roll; an overlay copy without
  that record is an untracked fork deviation.
- Follow the canonical [Overlay Contract](README.md#overlay-contract). The overlay is full-file and
  copy-only: never delete an upstream-tracked file as a downstream deviation, and never use `init`
  to resolve or overwrite dirty work.
- Validation sections contain exact runnable commands, not general instructions such as "run relevant tests."
- Keep `downstream/t3code/AGENTS.md` authoritative; init installs `downstream/skills/` into
  `~/.agents/skills/`, applies reviewed overlays, and leaves root `AGENTS.md` ending with its single
  downstream pointer.
- Use `vp node downstream/tools/downstream.ts build` for installable artifacts; do not persist release-version edits in the working branch.
- Keep `downstream/t3code/` limited to downstream-owned files; do not copy the whole upstream tree or add a patch engine, permanent mirror branch, or automatic merge workflow unless the current tooling has demonstrably stopped scaling.

## Completion Gate

Before finishing a downstream change, create or update its active record and exact `## Overlay
Files` list, synchronize every normal/overlay pair, confirm there is no unsupported upstream-file
deletion, run focused validation, and run `vp node downstream/tools/downstream.ts verify`. Do not
claim completion while ownership, byte equality, test isolation, or the verifier is failing.
