# Agent Scratch Files

## Why

Repository-root agent scratch files are local working memory and must never enter commits or builds.

## Affected Surfaces

- `.gitignore` ignores `findings.md`, `progress.md`, and `task_plan.md` only at the repository root.
- The files remain available locally and do not affect product code or generated artifacts.

## Overlay Files

- `.gitignore`

## Validation

```bash
git check-ignore findings.md progress.md task_plan.md
vp node downstream/tools/downstream.ts verify
git diff --check
```

## Removal Condition

Remove this deviation, its overlay, and this record when upstream ignores the same root scratch
files or the repository no longer uses them.
