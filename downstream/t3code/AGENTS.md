## Downstream build

This checkout is the maintained downstream product, not a pristine upstream tree. `origin/main` is the tested downstream branch, published T3 Code nightly tags are upstream baselines, and `downstream/` is the canonical downstream control layer.

Read `downstream/README.md` before adding a fork-only change or rolling to a new nightly. Executable product changes stay in their normal `apps/`, `packages/`, or other source paths and are mirrored under `downstream/t3code/` for reapplication, while each active fork-only deviation has a matching `downstream/changes/<slug>.md` record covering its purpose, affected surfaces, exact validation, and removal condition.

Run `vp node downstream/tools/downstream.ts roll` from a clean `main` to fetch and merge the newest nightly through `sync/nightly-<date>.<run>`. After resolving any merge conflict, run `vp node downstream/tools/downstream.ts init` so root `AGENTS.md` ends with its required pointer to this file; preserve every upstream instruction above that pointer.

Never rebase or force-push published downstream `main`. Resolve conflicts against current upstream architecture, preserve downstream behavior only where its active change record still requires it, and use `vp node downstream/tools/downstream.ts build` for traceable installable artifacts from an isolated temporary worktree.
