# Downstream T3 Code

This fork is a maintained downstream build of T3 Code. Official nightlies provide immutable upstream baselines; `origin/main` is the integrated version we build and run.

```text
upstream nightly tag
         |
         v
sync/nightly-<date>.<run> -- validation and CI --> origin/main
                                                  ^
                                      feat/* and fix/* branches
```

## Branches and Remotes

| Name | Purpose |
| --- | --- |
| `upstream` | Official `pingdotgg/t3code` repository. |
| `origin` | `TheSethRose/t3code`, the downstream fork. |
| `main` | Tested downstream product; never rebase or force-push after publication. |
| `sync/nightly-<date>.<run>` | Temporary branch for one upstream nightly roll. |
| `feat/*` and `fix/*` | Short-lived branches for independently removable downstream changes. |

There is no pristine mirror branch or permanent `custom` branch. `upstream/main` and upstream tags already provide clean references.

## Adding a Downstream Change

Start from downstream `main`, put executable code and tests in their normal repository paths, and keep each concern in a coherent commit or short commit series. Add `downstream/changes/<slug>.md` with these sections:

```markdown
# Change name

## Why

## Affected Surfaces

## Validation

## Removal Condition
```

A provider addition must make an explicit decision for contracts, server lifecycle, authentication and configuration, shared client runtime, web, desktop, and mobile. A bug patch should fix the shared root cause and retain the smallest focused regression test.

## Rolling to a Nightly

Start with a clean worktree and select the newest published nightly that we are prepared to accept:

```bash
git fetch origin --prune
git fetch upstream --tags --prune

nightly_tag="$(git tag --list 'v*-nightly.*' --sort=-creatordate | head -n 1)"
test -n "$nightly_tag"
nightly_suffix="${nightly_tag#*-nightly.}"
git switch main
git pull --ff-only origin main
git switch -c "sync/nightly-$nightly_suffix"
git merge --no-ff "$nightly_tag"
```

If more than one nightly shares a date, the tag still identifies the exact baseline; the branch name is only temporary coordination.

Resolve conflicts according to the current upstream architecture rather than mechanically preferring either side. Review every active file under `downstream/changes/`, remove deviations already supplied upstream, and run each record's focused validation. Push the sync branch and use a pull request into `main` when full CI proof is required. Preserve the upstream merge ancestry when integrating; do not squash the nightly roll.

If the roll fails, leave `main` on the last accepted baseline. `git merge --abort` restores an unresolved local merge, and deleting the failed sync branch does not affect the product branch.

## Removing a Downstream Change

When upstream ships equivalent behavior, remove the redundant downstream implementation and its active change record during the next roll. Keep a regression test only when it still protects behavior that upstream does not already cover.

## What Git Already Handles

Normal commits are the downstream patch set, merge ancestry records accepted upstream baselines, and CI validates the integrated tree. Do not add generated patch files, a second source tree, a baseline file, or synchronization automation until repeated manual rolls show a concrete need.
