# Downstream Maintenance

## Scope

This directory is the downstream-owned control layer. It contains coordination records, downstream agent instructions, and maintenance tooling; executable product source and regression tests stay in their normal repository paths.

Read the repository-root `AGENTS.md` and `downstream/README.md` before changing anything here.

## Active Changes

Create `changes/<slug>.md` in the same commit series that introduces fork-only behavior. Keep the record short and include:

- why the deviation exists;
- affected contracts, providers, clients, runtime paths, or source areas;
- focused validation required after an upstream roll;
- the upstream event or other condition that allows removal.

Update a record when its behavior or validation changes. Delete it with the redundant implementation when upstream absorbs the deviation; Git history is the archive.

## Integration Rules

- `origin/main` is the tested downstream product branch.
- Published upstream nightly tags are immutable integration inputs.
- Run `vp node downstream/tools/downstream.ts roll` from a clean `main`; do not reproduce its fetch, tag-selection, or branch setup by hand unless repairing the tool.
- Nightly rolls happen on temporary `sync/nightly-<date>.<run>` branches and merge into `main` only after validation.
- Fork-only features and fixes use short-lived topic branches and remain independently removable.
- Executable changes and regression tests stay in their normal repository paths, with each downstream-owned file mirrored at the same path under `downstream/t3code/`.
- Validation sections contain exact runnable commands, not general instructions such as "run relevant tests."
- Keep `downstream/t3code/AGENTS.md` authoritative and run the init command after resolving nightly conflicts; root `AGENTS.md` must retain every upstream instruction and end with its single downstream pointer.
- Use `vp node downstream/tools/downstream.ts build` for installable artifacts; do not persist release-version edits in the working branch.
- Keep `downstream/t3code/` limited to downstream-owned files; do not copy the whole upstream tree or add a patch engine, permanent mirror branch, or automatic merge workflow unless the current tooling has demonstrably stopped scaling.
