---
name: t3-review
description: Perform a separate adversarial review of one T3 Code downstream pull request against its linked GitHub issue, repository architecture, overlay contract, and validation evidence. Use when the user invokes $t3-review or asks for an independent downstream PR review. Post findings but never modify the branch.
---

# T3 Review

Review one pull request from a fresh, read-only posture. Report only source-proven problems that
change what the author should do.

## Authority

Explicit invocation with a PR authorizes reading its GitHub context and posting one review. It does
not authorize source edits, commits, pushes, labels, merging, issue closure, or deployment.

Read `AGENTS.md`, `downstream/t3code/AGENTS.md`, the linked issue, complete PR diff, changed records,
relevant source, callers, and focused tests. Use `gh` for GitHub.

## Review

Check whether:

- the diff satisfies the issue's smallest useful outcome and acceptance criteria;
- a shared root cause was fixed once rather than patched in one caller;
- applicable clients, providers, contracts, entry points, reverse states, and connection modes were
  handled or deliberately excluded;
- every normal downstream file matches its overlay and has exactly one active record owner;
- validation proves the claimed runtime behavior;
- the change introduces avoidable machinery or weakens security, data safety, compatibility, or
  accessibility.

Verify every suspected finding against current source. Rank actionable findings by severity and
attach them to the narrowest useful line. If there are no findings, say so and name any testing gap.
Submit one GitHub review or, when GitHub cannot accept a review from the current account, one PR
comment. Do not approve your own implementation identity or edit the branch.
