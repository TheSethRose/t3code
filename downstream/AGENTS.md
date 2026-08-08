# Downstream Maintenance

## Scope

This directory tracks how the fork differs from upstream T3 Code. It contains coordination records, not executable source or generated patch files.

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
- Nightly rolls happen on temporary `sync/nightly-<date>.<run>` branches and merge into `main` only after validation.
- Fork-only features and fixes use short-lived topic branches and remain independently removable.
- Executable changes and regression tests stay in their normal repository paths.
- Do not add a patch engine, duplicated source tree, or permanent mirror branch unless the manual workflow has demonstrably stopped scaling.
