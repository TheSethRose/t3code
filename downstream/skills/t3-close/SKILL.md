---
name: t3-close
description: Verify that a merged T3 Code downstream pull request satisfies its linked GitHub issue at the real required boundary, then comment with evidence and close the issue. Use when the user invokes $t3-close or asks to verify and close shipped downstream work. Never change source or close on failed proof.
---

# T3 Close

Close the loop only after the merged result is proven. A merged PR or green CI alone is not runtime
verification.

## Authority

Explicit invocation with an issue or merged PR authorizes read-only verification, one evidence
comment, and issue closure after success. It does not authorize source changes, follow-up branches,
releases, deployment, artifact installation, or closing on failure.

Read `AGENTS.md`, `downstream/t3code/AGENTS.md`, the issue, merged PR, active change record, and
relevant verification instructions. Use `gh` for GitHub.

## Verify and Close

1. Prove the PR is merged, its commit is on `origin/main`, required checks passed on that revision,
   and the merged behavior still matches the issue acceptance criteria.
2. Run the active record's focused checks on current `main`, plus
   `vp node downstream/tools/downstream.ts verify`.
3. Prove the real boundary when required: actual provider runtime, real client behavior when
   requested, persisted data, remote connection, or installable artifact. Do not substitute a build
   or mock for the claimed result.
4. On success, comment with the merge commit, exact checks and results, runtime proof, and active
   record path; then close the issue.
5. On failure, leave the issue open and comment with the exact failed proof and smallest next action.

Do not create a downstream record for behavior now owned by upstream. Do not build a DMG unless the
issue's acceptance criteria explicitly require one.
