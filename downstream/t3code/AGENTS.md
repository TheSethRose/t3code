## Downstream build

This checkout is the maintained downstream product, not a pristine upstream tree. `origin/main` is the tested downstream branch, published T3 Code nightly tags are upstream baselines, and `downstream/` is the canonical downstream control layer.

Read `downstream/README.md` before adding a fork-only change or rolling to a new nightly. Executable product changes stay in their normal `apps/`, `packages/`, or other source paths and are mirrored under `downstream/t3code/` for reapplication, while each active fork-only deviation has a matching record under `downstream/changes/` covering its purpose, affected surfaces, exact validation, and removal condition. Bug records live under `downstream/changes/Bugs/`.

Run `vp node downstream/tools/downstream.ts roll` from a clean `main` to fetch and merge the newest nightly through `sync/nightly-<date>.<run>`. After the upstream merge, use `$merge-t3code-downstream` to reconcile every full-file overlay before running `vp node downstream/tools/downstream.ts init`; init installs repo-owned skills and copies overlays, so it must not be used as a conflict resolver.

Never rebase or force-push published downstream `main`. Resolve conflicts against current upstream architecture, preserve downstream behavior only where its active change record still requires it, and use `vp node downstream/tools/downstream.ts build` for traceable installable artifacts from an isolated temporary worktree.
