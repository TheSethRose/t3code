---
name: merge-t3code-downstream
description: Orchestrate a complete T3 Code downstream update from the exact current upstream/main commit through overlay reconciliation, validation, local main integration, and a rebuilt DMG. Use when the user invokes $merge-t3code-downstream or asks to sync, merge, update, catch up, reapply downstream changes, or rebuild the downstream T3 Code artifact. Push only when explicitly requested.
---

# Merge T3 Code Downstream

Own the complete update. Do not stop after fetching, merging, listing conflicts, applying overlays, or
printing commands the agent can run. Finish with a validated DMG on the latest fetched
`upstream/main`, or report the exact blocking failure and preserved recovery state.

## Invocation Authority

An explicit invocation authorizes the local operations required by this workflow: safety-stashing
unrelated work, creating a sync branch, resolving files, committing the reviewed reconciliation,
fast-forwarding local `main`, running validation, and building the artifact. It does not authorize a
push, pull request, release, upload, or installer execution unless the user explicitly asks for it.

Read `AGENTS.md`, `downstream/t3code/AGENTS.md`, `downstream/README.md`, and every active record
under `downstream/changes/` before changing state.

## 1. Preserve the Starting State

Inspect `git status --short`, the current branch, remotes, existing merge state, and safety stashes.

- If unrelated work is cleanly separable, stash it with untracked files under a unique
  `safety: downstream sync ...` message and record the exact stash ref for restoration.
- If unrelated work overlaps an upstream-changed path, an overlay, or a change record, stop before
  editing and ask for direction.
- Never drop an existing stash, rewrite published `main`, force-push, or use a broad destructive
  command.
- Resume an existing `sync/upstream-<sha>` merge when its target and prior baseline can be proven;
  otherwise start from clean `main`.

## 2. Fetch and Merge the Exact Upstream Tip

From clean `main`, run:

```bash
vp node downstream/tools/downstream.ts roll
```

This fetches both remotes, fast-forwards from `origin/main`, records the exact fetched
`upstream/main` SHA, and merges it on `sync/upstream-<sha>`. During a conflicted merge,
`HEAD` is the prior downstream state and `MERGE_HEAD` is the target. After a clean merge commit,
`HEAD^1` is the prior state and `HEAD^2` is the target.

Prove the range before reconciliation:

```bash
git merge-base <prior-ref> upstream/main
test "$(git rev-parse <target-ref>)" = "$(git rev-parse upstream/main)"
git merge-base --is-ancestor <previous-upstream> <target-ref>
```

If `roll` reports that `main` is current, continue through validation and the DMG build; current
source is not proof that the downstream artifact is current.

## 3. Reconcile Every Downstream Deviation

Treat the Git-merged normal source as the starting point and `downstream/t3code/` as a recovery
copy, never as a side to accept wholesale.

1. Map every overlay to its normal path and intersect that set with
   `git diff --name-only <previous-upstream>..<target-ref>`.
2. Review every intersection even when Git merged cleanly. Inspect the upstream change, prior
   downstream delta, merged file, overlay, active record, and affected callers.
3. Preserve upstream architecture. Adapt only the smallest downstream behavior still required by an
   active record.
4. When upstream supplies equivalent behavior, remove the downstream implementation, overlay, and
   active record together. Do not infer equivalence without evidence.
5. Make every retained normal/overlay pair byte-identical and update its record when affected
   surfaces, validation, or removal conditions changed.
6. Review `downstream/t3code/AGENTS.md` directly; `init` appends its pointer without replacing
   upstream root instructions.

Never run `init` as a conflict resolver.

## 4. Apply and Prove the Integrated Tree

After both copies already contain the reviewed result, run:

```bash
vp node downstream/tools/downstream.ts init
```

Run every active change record's exact validation commands, then:

```bash
vp node --test downstream/tools/downstream.test.ts
vp exec tsgo -p downstream/tools/tsconfig.json --noEmit
vp node downstream/tools/downstream.ts verify
git diff --check
vp run build:desktop
```

Do not replace focused checks with repo-wide checks. Fix real failures at their root and rerun the
failed check plus any dependent checks. Inspect the final diff and status. Commit only the reviewed
sync and reconciliation files with conventional commit messages; preserve merge ancestry and never
squash the upstream merge.

## 5. Build the DMG Before Integrating Main

The candidate must be clean and `downstream.ts verify` must pass. Use the reconciled sync commit, or
clean `main` when `roll` reported it current. Build the installable artifact from that exact commit:

```bash
vp node downstream/tools/downstream.ts build
```

Record the downstream version and the files created or updated under `release/downstream/`. A
failed build blocks local `main` integration and any requested push.

## 6. Recheck Latest and Integrate

Fetch upstream again after the build. If `upstream/main` moved beyond the candidate, repeat the
merge, reconciliation, validation, and build on the new exact SHA. Do not publish a candidate that
is already behind at this gate.

When the candidate still contains the fetched tip, fast-forward `main` from the sync branch. If
`roll` reported current and the candidate is already `main`, skip only the switch and merge:

```bash
git switch main
git merge --ff-only sync/upstream-<sha>
vp node downstream/tools/downstream.ts verify
git merge-base --is-ancestor upstream/main main
```

Push `main` only when the user explicitly requested it, and verify the remote SHA afterward. Do not
open a pull request unless explicitly requested.

## 7. Restore and Report

Restore the exact safety stash created in step 1. Apply it first, verify the original paths and
contents returned, then drop only that stash. If restoration conflicts, keep the stash and report the
conflict instead of guessing.

Report:

- accepted upstream SHA and downstream `main` SHA;
- proof that upstream has zero commits missing at the final fetch;
- overlaps reviewed and downstream behaviors retained, adapted, or removed;
- validation and build results;
- exact DMG path;
- push status;
- unrelated work restoration status.

## Stop Conditions

Stop without deleting recovery state when the target or previous baseline cannot be proven, unrelated
work overlaps the sync, a deviation might be upstream-equivalent but evidence is insufficient, a
validation/build fails after root-cause attempts, or safety-stash restoration conflicts.
