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

| Name                        | Purpose                                                                  |
| --------------------------- | ------------------------------------------------------------------------ |
| `upstream`                  | Official `pingdotgg/t3code` repository.                                  |
| `origin`                    | `TheSethRose/t3code`, the downstream fork.                               |
| `main`                      | Tested downstream product; never rebase or force-push after publication. |
| `sync/nightly-<date>.<run>` | Temporary branch for one upstream nightly roll.                          |
| `feat/*` and `fix/*`        | Short-lived branches for independently removable downstream changes.     |

There is no pristine mirror branch or permanent `custom` branch. `upstream/main` and upstream tags already provide clean references.

## Bootstrap Boundary

The supported starting point is a clone of the downstream fork, not a fresh upstream checkout:

```bash
git clone https://github.com/TheSethRose/t3code t3code-downstream
cd t3code-downstream
vp install
vp node downstream/tools/downstream.ts init
vp node downstream/tools/downstream.ts verify
```

A nightly update merges an upstream tag into downstream `main`; it never resets `main` to an upstream tag. That is why `downstream/`, its tools, and downstream product changes remain available while the upstream tree advances. A raw upstream checkout must retrieve `downstream/` from the fork before it can run the initializer.

All downstream-only maintenance code lives under `downstream/tools/`. `downstream/t3code/` mirrors paths in the T3 Code tree that the initializer must restore after an upstream update; its `AGENTS.md` is the one intentional special case because the initializer appends a pointer to it instead of replacing upstream's root instructions. Product code still runs from the normal repository paths so the integrated build and CI exercise the real tree.

To rebuild from a disposable official checkout, retrieve only the control layer from the fork and apply it:

```bash
git clone https://github.com/pingdotgg/t3code t3code-downstream
cd t3code-downstream
git remote rename origin upstream
git remote add origin https://github.com/TheSethRose/t3code
git fetch origin main
git restore --source origin/main -- downstream
vp install
vp node downstream/tools/downstream.ts init
vp node downstream/tools/downstream.ts verify
```

No symlink is involved, so the resulting tree works in a fresh clone and in CI. Add each downstream-owned file under `downstream/t3code/` at the same relative path it has in the repository. The initializer copies those files over the upstream tree; root `AGENTS.md` remains composed because replacing it would discard new upstream instructions.

## Machine Setup

Vite+ reads the required Node version and pnpm version from `package.json`:

```bash
curl -fsSL https://vite.plus | bash
vp install
vp node --version
```

The resolved Node version must satisfy the repository's `engines.node`; do not add a second version file or install a competing repository-local package manager. Install current stable Rust before building desktop artifacts because T3's native resource monitor compiles during packaging:

```bash
rustup update stable
rustc --version
```

On macOS, the desktop artifact builder also requires the Xcode command-line build tools. GitHub CLI is optional and is only needed to open pull requests from the terminal.

Enable Git's repository-local conflict memory once:

```bash
git config --local rerere.enabled true
git config --local rerere.autoupdate false
```

`rerere` can propose a resolution seen during an earlier nightly roll, but it does not stage that resolution. Review every reused resolution before adding it.

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

Every downstream-owned source file must have an exact counterpart under `downstream/t3code/`. When a nightly changes an upstream file that we also own, review the new upstream version and update both the working file and its overlay copy; `verify` rejects byte drift between them.

## Rolling to a Nightly

Start from a clean downstream `main`:

```bash
git switch main
vp node downstream/tools/downstream.ts roll
```

The command verifies clean state and required remotes, fetches `origin` and upstream tags, fast-forwards local `main` from `origin/main`, selects the newest published nightly, and creates `sync/nightly-<date>.<run>`. It exits without changing branches when `main` already contains that nightly. To roll a specific published nightly:

```bash
vp node downstream/tools/downstream.ts roll --tag vX.Y.Z-nightly.YYYYMMDD.RUN
```

The tool does not push, open a pull request, resolve conflicts, or merge the sync branch into downstream `main`. Those are review boundaries, not setup chores. After a clean merge it also runs the downstream initializer, which preserves upstream's root `AGENTS.md` and restores one final line requiring agents to read `downstream/t3code/AGENTS.md`.

## Resolving and Validating a Roll

Resolve conflicts according to the current upstream architecture rather than mechanically preferring either side. Review every active file under `downstream/changes/`, remove deviations already supplied upstream, and run every command in each record's `Validation` section.

When Git reports conflicts:

```bash
git status --short
# edit and review each conflicted file
vp node downstream/tools/downstream.ts init
git status --short
git add <all-resolved-and-applied-files>
git commit
```

Use `git merge --abort` to abandon the roll and return to downstream `main`. Git keeps `main` on the last accepted baseline until the sync branch is explicitly integrated. The init command is idempotent: it removes the obsolete embedded downstream block if present, preserves the upstream file, and leaves exactly one downstream pointer as the final line.

Verify the instruction invariant at any time:

```bash
vp node downstream/tools/downstream.ts verify
```

For a successful merge, run focused change validation first, then compile the integrated desktop/server/web pipeline:

```bash
vp run build:desktop
```

Push the sync branch and open a pull request into `main` when full CI proof is required:

```bash
git push -u origin "$(git branch --show-current)"
gh pr create --base main --fill
```

Do not squash the nightly roll; the upstream merge ancestry records the accepted baseline.

## Building an Installable Artifact

Build the current clean commit with a unique downstream version:

```bash
vp node downstream/tools/downstream.ts build
```

The command derives a version such as `0.0.33-downstream.20260808.1035.2629ed29330a`, creates a detached temporary worktree, installs the pinned dependencies, reuses T3's release-version alignment script, and runs the existing host artifact builder. Output lands in `release/downstream/`, and the temporary worktree is removed even when the build fails.

The artifact build deliberately removes `T3CODE_DESKTOP_UPDATE_REPOSITORY` and `GITHUB_REPOSITORY` from its build environment. This prevents an installed downstream build from replacing itself with an official or incomplete fork release. A fork update channel must publish matching desktop artifacts and the exact server/CLI version before enabling updates.

For a compile-only check, use `vp run build:desktop`. For development, use the existing `vp run dev` or `vp run dev:desktop` commands instead of producing an installer.

## Removing a Downstream Change

When upstream ships equivalent behavior, remove the redundant downstream implementation and its active change record during the next roll. Keep a regression test only when it still protects behavior that upstream does not already cover.

## What Git Already Handles

Normal commits are the downstream patch set, merge ancestry records accepted upstream baselines, and CI validates the integrated tree. The downstream commands only automate repeatable setup and isolated packaging. Keep `downstream/t3code/` limited to downstream-owned files; do not copy the whole upstream tree or add generated patch files, a baseline file, automatic conflict resolution, or automatic merging.
