---
name: t3-work
description: Implement one ready GitHub issue in the maintained T3 Code downstream fork, including the branch, code, overlays, active change record, focused validation, commit, push, and draft pull request. Use when the user invokes $t3-work or asks to work, implement, or fix a scoped downstream GitHub issue. Do not merge or close the issue.
---

# T3 Work

Take one ready issue through a truthful draft pull request. Keep the diff to the smallest complete
change and preserve unrelated work.

## Authority

Explicit invocation with an issue authorizes a topic branch, implementation, focused validation,
commits, branch push, and draft pull request. It does not authorize merging, closing the issue,
releasing, deploying, or installing an artifact.

Read `AGENTS.md`, `downstream/t3code/AGENTS.md`, `downstream/README.md`, the issue, relevant source
and tests, and intersecting records under `downstream/changes/` before editing. Use `gh` for GitHub.

## 1. Confirm the Work

- Resolve the repository from `origin`; never guess an owner or repository.
- Require a concrete problem, smallest useful outcome, and acceptance criteria. Treat a `ready`
  label as approval to implement; otherwise report the missing decision and stop.
- Inspect `git status --short`, current branch, remotes, and current `origin/main`. Preserve unrelated
  changes. Stop if they overlap the work.
- Search every caller of the shared boundary being changed and decide which clients, providers,
  contracts, entry points, reverse states, and connection modes apply.

## 2. Implement

Start `feat/<short-name>` or `fix/<short-name>` from current downstream `main`. Fix the root cause
with the fewest files. Keep executable code in normal paths, mirror every downstream-owned file
under `downstream/t3code/`, and create or update one concise active record containing:

```markdown
# Change name

GitHub: #123

## Why

## Affected Surfaces

## Overlay Files

## Validation

## Removal Condition
```

Add one focused regression check for non-trivial behavior. Do not add speculative abstractions,
cleanup, or a DMG build.

## 3. Validate and Open the PR

Run the record's focused checks, then:

```bash
vp node downstream/tools/downstream.ts verify
git diff --check
```

Inspect the final diff and staged scope. Commit only this issue's work with a conventional commit,
push the topic branch, and open a draft PR using `Relates to #<issue>` rather than an auto-closing
keyword. Include what changed, downstream impact, exact validation results, UI evidence when
applicable, and the removal condition.

Leave the PR draft and report any acceptance criterion that lacks proof.
