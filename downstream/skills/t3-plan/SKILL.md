---
name: t3-plan
description: Investigate an idea, bug, request, or legacy downstream plan and create or update grounded GitHub issues for the maintained T3 Code fork. Use when the user invokes $t3-plan or asks to plan, capture, scope, migrate planned docs, or turn work into GitHub issues. Never implement, create a branch or PR, or mark an issue ready.
---

# T3 Plan

Turn each independently useful request into one grounded GitHub issue. Keep uncertainty visible and
leave implementation approval to the user.

## Authority

Explicit invocation authorizes read-only repository and GitHub investigation plus creating or
updating one issue. A bounded migration request may create one issue per supplied legacy plan. It
does not authorize source or plan file edits, branches, commits, pull requests, implementation, a
`ready` label, or issue closure. Delete migrated plans only when the user explicitly asks.

Read `AGENTS.md`, `downstream/t3code/AGENTS.md`, `downstream/README.md`, the supplied request or plan,
relevant current source and tests, active records under `downstream/changes/`, and matching open
and closed GitHub issues. Resolve the repository from `origin`; use `gh` and never guess its owner.

## 1. Investigate

- Confirm the concrete user or maintenance problem and reject duplicate or already-shipped work.
- Trace enough current code to explain the existing mechanism and affected surfaces accurately.
- Inspect `.github/ISSUE_TEMPLATE/` and any repository-owned label-sync workflow before drafting.
  Treat the matching template's title prefix, fields, and labels as authoritative.
- Separate confirmed behavior, desired outcome, open decisions, and implementation ideas. Mark
  implementation details as inference unless source proves them.
- Find the smallest independently useful result. Do not turn optional follow-ups into requirements.

If an equivalent open issue exists, update that issue instead of creating a duplicate. If the idea
is too ambiguous to describe a useful outcome, report the missing product decision and stop.

## 2. Create the Issue

Follow the matching issue template in its field order. Add any missing planning information so the
issue still covers:

```markdown
## Problem or use case

## Current behavior

## Smallest useful outcome

## Affected surfaces

## Acceptance criteria

## Out of scope

## Open decisions
```

If no matching template exists, use the headings above. Make the issue standalone: preserve the
useful decisions from a legacy plan instead of relying on a path that may be deleted. Use observable
acceptance criteria, name deliberate unsupported surfaces, and link relevant current source, tests,
or active records.

Prefer existing GitHub default labels and labels declared by the selected template. Do not invent a
parallel taxonomy. If a template-declared label is missing, create it only when repository config
already defines its name, color, and description. Never apply `ready`; the user does that after
reviewing scope.

For multiple legacy plans, create one issue per independently scoped plan. Do not combine unrelated
plans into an umbrella issue or split one plan unless it contains independently shippable outcomes.

## 3. Verify and Migrate

Read each created or updated issue back from GitHub. Confirm its title, URL, body sections, and exact
labels before reporting success or changing local files.

When the user explicitly requests removal, delete only a legacy plan whose issue passed that check.
Preserve unrelated files and stop before deleting any plan whose issue creation or verification
failed. Untracked and modified plans follow the same rule; Git status is not a reason to omit them
from an explicitly bounded migration.

## 4. Report

Return each issue URL, title, labels, smallest useful outcome, and open decisions. State which legacy
files were removed, if any. Do not leave a new local planning file or touch unrelated scratch files.
