## Downstream build

This checkout is the maintained downstream product, not a pristine upstream tree. `origin/main` is the tested downstream branch, each accepted `upstream/main` commit is an integration baseline, and `downstream/` is the canonical downstream control layer.

Read `downstream/README.md` before adding a fork-only change or syncing upstream. Executable product changes stay in their normal `apps/`, `packages/`, or other source paths and are mirrored under `downstream/t3code/` for reapplication, while each active fork-only deviation has a matching record under `downstream/changes/` covering its purpose, affected surfaces, exact validation, and removal condition. Bug records live under `downstream/changes/Bugs/`.

Invoke `$t3-sync` for the complete source update: preserve unrelated work, fetch and merge the exact `upstream/main` tip, reconcile every overlay, validate once, fast-forward local `main`, and restore the starting worktree. It does not build a DMG. Invoke `$t3-build` separately for an exact-commit DMG. The skills run `downstream.ts roll`, `inspect`, `init`, `verify`, and `build` at the correct boundaries; use those commands directly only when repairing or diagnosing the workflows.

Never rebase or force-push published downstream `main`. Resolve conflicts against current upstream architecture, preserve downstream behavior only where its active change record still requires it, and use `vp node downstream/tools/downstream.ts build` for traceable installable artifacts from an isolated temporary worktree.
