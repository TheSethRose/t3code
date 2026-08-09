---
name: t3-plan
description: Investigate an idea, bug, request, or legacy downstream plan and create or update one scoped GitHub issue for the maintained T3 Code fork. Use when the user invokes $t3-plan or asks to plan, capture, scope, or turn work into an issue. Never implement, create a branch or PR, or mark the issue ready.
---

# T3 Plan

Turn one request into one grounded GitHub issue. Keep uncertainty visible and leave implementation
approval to the user.

## Authority

Explicit invocation authorizes read-only repository and GitHub investigation plus creating or
updating one issue and its `downstream` and `planned` labels. It does not authorize source or plan
file edits, branches, commits, pull requests, implementation, a `ready` label, or issue closure.

Read `AGENTS.md`, `downstream/t3code/AGENTS.md`, `downstream/README.md`, the supplied request or plan,
relevant current source and tests, active records under `downstream/changes/`, and matching open
GitHub issues. Resolve the repository from `origin`; use `gh` and never guess its owner.

## 1. Investigate

- Confirm the concrete user or maintenance problem and reject duplicate or already-shipped work.
- Trace enough current code to explain the existing mechanism and affected surfaces accurately.
- Separate confirmed behavior, desired outcome, open decisions, and implementation ideas. Mark
  implementation details as inference unless source proves them.
- Find the smallest independently useful result. Do not turn optional follow-ups into requirements.

If an equivalent open issue exists, update that issue instead of creating a duplicate. If the idea
is too ambiguous to describe a useful outcome, report the missing product decision and stop.

## 2. Create the Issue

Create or update one issue with:

```markdown
## Problem

## Current behavior

## Smallest useful outcome

## Affected surfaces

## Acceptance criteria

## Out of scope

## Open decisions
```

Use observable acceptance criteria, name deliberate unsupported surfaces, and link relevant source,
tests, active records, or legacy plan paths. Apply `downstream` and `planned`, creating only those
labels if missing. Never apply `ready`; the user does that after reviewing scope.

## 3. Report

Return the issue URL, title, labels, smallest useful outcome, and open decisions. Do not leave a new
local planning file. When invoked to migrate a legacy `downstream/docs/planned/*.md`, preserve that
file unless the user separately asks to remove migrated plans after verifying the issue.
