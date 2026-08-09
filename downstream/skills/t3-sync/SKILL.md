---
name: t3-sync
description: Synchronize the maintained T3 Code fork and its GitHub main branch to the exact current upstream/main commit, reconcile every intersecting downstream overlay, validate once, and push the combined downstream history. Use when the user invokes $t3-sync or asks to sync, merge, update, catch up, or reapply downstream changes. Never build a DMG, force-push, or open a pull request.
---

# T3 Sync

Finish with validated local and `origin/main` containing the latest fetched `upstream/main` plus
every retained downstream behavior. Do not build a desktop artifact.

## Authority

Explicit invocation authorizes safety-stashing unrelated work, creating a sync branch, resolving
files, committing reconciliation, fast-forwarding local `main`, focused validation, and a normal
push of that validated `main` to the configured fork origin. It does not authorize a force-push,
pull request, DMG build, release, upload, or installer execution. Skip the push only when the user
explicitly requests a local-only sync.

Read `AGENTS.md`, `downstream/t3code/AGENTS.md`, `downstream/README.md`, and every active record under
`downstream/changes/` before changing state.

## 1. Preserve State

Inspect status, branch, remotes, merge state, and safety stashes. Stash cleanly separable unrelated
work, including untracked files, under a unique `safety: t3 sync ...` message and record its exact
ref. Stop if unrelated work overlaps an upstream-changed path, overlay, or active record. Never
rewrite published `main`, force-push, or drop an existing stash.

## 2. Merge Exact Upstream

From clean `main`, run:

```bash
vp node downstream/tools/downstream.ts roll
vp node downstream/tools/downstream.ts inspect
```

Confirm the reported target equals fetched `upstream/main`. Review every reported overlay
intersection even when Git merged cleanly. Preserve upstream architecture, retain only behavior
still required by an active record, and remove an implementation, overlay, and record together when
upstream equivalence is proven. Make retained normal and overlay files byte-identical. Never use
`init` as a conflict resolver.

## 3. Validate Once

Run `vp node downstream/tools/downstream.ts init`. Deduplicate active-record validation: keep every
distinct focused check, combine compatible test paths, run each package typecheck once, and keep
environment-dependent probes separate. Then run:

```bash
vp node --test downstream/tools/downstream.test.ts
vp exec tsgo -p downstream/tools/tsconfig.json --noEmit
vp node downstream/tools/downstream.ts verify
git diff --check
```

Do not run `vp run build:desktop` or `downstream.ts build`. Fix root causes, rerun affected checks,
inspect scope, and commit only the reviewed sync while preserving merge ancestry.

## 4. Integrate and Restore

Fetch upstream again. If it advanced, repeat reconciliation and validation. Otherwise fast-forward
local `main` from `sync/upstream-<sha>`, verify zero missing upstream commits, and rerun downstream
verification.

Restore the exact safety stash, verify the starting work returned, then drop only that stash. If
restoration conflicts, keep it and report the recovery state.

Fetch `origin/main` immediately before publishing and require it to be an ancestor of local `main`.
Push with `git push origin main:main`; never force. Fetch origin again, require
`origin/main == local main`, and require `git rev-list --count origin/main..upstream/main` to be zero.
Stop if the remote advanced independently or any remote proof fails.

Report upstream, local `main`, and `origin/main` SHAs; both zero-missing proofs; intersections
reviewed; retained or removed deviations; validation results; and worktree restoration. A local
commit that was not pushed is not a completed sync unless the user requested local-only operation.
