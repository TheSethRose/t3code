---
name: merge-t3code-downstream
description: Reconcile this maintained T3 Code fork with the current upstream main commit. Use after `downstream.ts roll`, to resolve upstream sync conflicts, or before applying `downstream/t3code/` overlays. Review overlays against upstream, sync both copies, and remove deviations upstream has absorbed.
---

# Merge T3 Code Downstream

Treat the Git-merged source file as the starting point and `downstream/t3code/` as a recovery copy,
not a file to accept wholesale. Reconcile every upstream-owned file before running `downstream.ts
init`, because init deliberately copies overlays over the working tree.

## Preserve the Boundary

- Read `AGENTS.md`, `downstream/t3code/AGENTS.md`, `downstream/README.md`, and the active records in
  `downstream/changes/` before editing.
- Keep upstream architecture and conventions unless an active downstream record still requires a
  deviation.
- Preserve unrelated work and do not stage, commit, push, or open a pull request unless requested.
- Never use `downstream.ts init` to resolve a merge. Run it only after the working files and overlay
  copies already represent the reviewed result.

## Reconcile Upstream

1. **Establish the two baselines.** Inspect `git status --short`, the current branch, and the merge
   parents. During a conflicted merge, the prior downstream state is `HEAD` and the new upstream
   state is `MERGE_HEAD`. After a clean merge commit, they are `HEAD^1` and `HEAD^2`. Identify the
   previous accepted upstream commit reachable from the prior downstream state, and confirm the
   target ref is the exact fetched `upstream/main` commit:

   ```bash
   git merge-base <prior-ref> upstream/main
   test "$(git rev-parse <target-ref>)" = "$(git rev-parse upstream/main)"
   git merge-base --is-ancestor <previous-upstream> <target-ref>
   ```

2. **Inventory every overlap.** List files below `downstream/t3code/`, map them to their normal
   repository paths, and compare that set with `git diff --name-only <previous-upstream>..<target-ref>`.
   Review every intersection even when Git reported no conflict; a full-file overlay can erase a
   clean upstream edit. Link each retained deviation to an active `downstream/changes/*.md` record.
   Treat `downstream/t3code/AGENTS.md` as the documented exception: review its downstream
   instructions directly, while init preserves the upstream root `AGENTS.md` and appends only the
   downstream pointer.

3. **Resolve from intent.** For each overlapping path, inspect the upstream change, the prior
   downstream delta, the current Git-merged file, the overlay copy, and every caller affected by the
   behavior. Adapt the smallest still-required downstream change to the current upstream extension
   point. Do not choose an entire side. If upstream now supplies equivalent behavior, remove the
   downstream implementation, its overlay, and its change record together.

4. **Synchronize both copies.** Once the normal source path is correct, make its
   `downstream/t3code/<path>` counterpart byte-identical. Retain downstream-only files only while an
   active record requires them. Update a record when its affected surfaces, validation, or removal
   condition changed.

5. **Prove the result.** Run init only after every working file and overlay contain the reviewed
   result:

   ```bash
   vp node downstream/tools/downstream.ts init
   ```

   Then run every affected record's focused validation followed by:

   ```bash
   vp node --test downstream/tools/downstream.test.ts
   vp exec tsgo -p downstream/tools/tsconfig.json --noEmit
   vp node downstream/tools/downstream.ts verify
   git diff --check
   ```

   Inspect `git status --short` and the final diff. Report which upstream-overlap files were reviewed,
   which downstream behaviors were retained, adapted, or removed, and which checks passed.

## Stop Conditions

- Stop before editing when the target upstream commit or previous accepted baseline cannot be established.
- Stop before deleting a deviation when no active record proves that upstream behavior is equivalent.
- If the working tree contains unrelated edits that overlap the roll, preserve them and ask for
  direction rather than folding them into the upstream merge.
