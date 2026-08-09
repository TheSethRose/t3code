# Downstream T3 Code

This fork is a maintained downstream build of T3 Code. Each fetched `upstream/main` tip provides the next exact integration baseline; `origin/main` is the integrated version we build and run.

## Documentation

Start with the [downstream documentation index](docs/README.md). The upstream
[`docs/`](../docs/README.md) tree remains the source of truth for shared T3 Code architecture and
user behavior; the downstream docs cover only the fork-specific layer:

- [Product Boundary](docs/product-boundary.md) defines owned and supported product surfaces.
- [Compatibility](docs/compatibility.md) covers nightly, contract, version, settings, and data rules.
- [Release and Distribution](docs/release-and-distribution.md) separates the current local artifact
  path from future publication requirements.
- [Change Lifecycle](docs/feature-lifecycle.md) is the required workflow for adding, rolling, and
  removing a downstream change.
- [Services and Security](docs/services-and-security.md) defines hosted-service, credential, pairing,
  and workflow boundaries.
- [Provider Architecture](docs/providers.md) maps the provider model and the checklist for adding one
  downstream.

```text
upstream/main commit
         |
         v
sync/upstream-<sha> -- validation and CI --> origin/main
                                                  ^
                                      feat/* and fix/* branches
```

## Branches and Remotes

| Name                  | Purpose                                                                  |
| --------------------- | ------------------------------------------------------------------------ |
| `upstream`            | Official `pingdotgg/t3code` repository.                                  |
| `origin`              | `TheSethRose/t3code`, the downstream fork.                               |
| `main`                | Tested downstream product; never rebase or force-push after publication. |
| `sync/upstream-<sha>` | Temporary branch for one exact upstream-main sync.                       |
| `feat/*` and `fix/*`  | Short-lived branches for independently removable downstream changes.     |

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

An upstream update merges the fetched `upstream/main` commit into downstream `main`; it never resets `main` to upstream. That is why `downstream/`, its tools, and downstream product changes remain available while the upstream tree advances. A raw upstream checkout must retrieve `downstream/` from the fork before it can run the initializer.

Downstream-only maintenance code lives under `downstream/tools/`, and repo-owned maintenance skills
live under `downstream/skills/`. Init installs each skill into `~/.agents/skills/`.
`downstream/t3code/` mirrors paths in the T3 Code tree that the initializer restores after review;
its `AGENTS.md` is the one intentional special case because the initializer appends a pointer to it
instead of replacing upstream's root instructions. Product code still runs from the normal
repository paths so the integrated build and CI exercise the real tree.

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

No symlink is involved, so the resulting tree works in a fresh clone and in CI. Add each downstream-owned file under `downstream/t3code/` at the same relative path it has in the repository. The initializer installs repo-owned skills and copies reviewed overlays over the upstream tree; root `AGENTS.md` remains composed because replacing it would discard new upstream instructions.

## Overlay Contract

Product code and tests execute only from their normal T3 paths. Every downstream-owned normal file
must have a byte-identical full-file copy at the same relative path under `downstream/t3code/`, and
exactly one active record under `downstream/changes/` must list that path under `## Overlay Files`.
The record makes ownership, upstream review, validation, and later removal intentional; an unowned
overlay is invalid.

The overlay is copy-only. It can add or replace a complete file, but it cannot represent deletion of
an upstream-tracked file. Do not delete an upstream file as a downstream deviation unless the
downstream tool first gains an explicit, tested tombstone mechanism. Mirrored tests remain inert
under `downstream/t3code/` and run only from their normal paths; the root test configuration must
exclude the overlay tree.

`init` restores already-reviewed overlays; it is not a conflict resolver. It refuses to overwrite a
dirty destination that differs from its overlay. During an upstream sync, reconcile the normal file
and overlay first with `$merge-t3code-downstream`, then run `init` and `verify`.

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

`rerere` can propose a resolution seen during an earlier upstream sync, but it does not stage that resolution. Review every reused resolution before adding it.

## Adding a Downstream Change

Follow the [Change Lifecycle](docs/feature-lifecycle.md). Start from downstream `main`, put
executable code and tests in their normal repository paths, and keep each concern in a coherent
commit or short commit series. Add a record under `downstream/changes/`, using
`downstream/changes/Bugs/<slug>.md` for bug fixes, with these sections:

```markdown
# Change name

## Why

## Affected Surfaces

## Overlay Files

## Validation

## Removal Condition
```

A provider addition must also follow [Provider Architecture](docs/providers.md) and make an explicit
decision for contracts, server lifecycle, authentication and configuration, shared client runtime,
web, desktop, and mobile. A bug patch should fix the shared root cause and retain the smallest
focused regression test.

Every downstream-owned source, test, and configuration file must follow the [Overlay
Contract](#overlay-contract). When upstream changes a file that we also own, review the
new upstream version and update both the working file and its overlay copy; `verify` rejects byte
drift, missing or duplicate change-record ownership, stale record entries, unsupported upstream-file
deletions, and executable mirrored tests.

## Syncing Upstream

Invoke the repository skill:

```text
$merge-t3code-downstream
```

The skill owns the complete local pipeline: preserve unrelated work, fetch the exact
`upstream/main` tip, create or resume `sync/upstream-<sha>`, reconcile every overlapping overlay,
run all active-record and control-plane validation, build the DMG from the clean candidate, recheck
that upstream has not advanced, fast-forward local `main`, and restore the starting worktree. It
pushes or opens a pull request only when explicitly requested.

`downstream.ts roll`, `init`, `verify`, and `build` remain the deterministic primitives used by the
skill. Run them directly only when repairing or diagnosing a failed orchestration. Never use `init`
to resolve a merge, and never squash the upstream merge ancestry.

## Building an Installable Artifact

Read [Release and Distribution](docs/release-and-distribution.md) before distributing an artifact;
the current command builds a local host-platform artifact but does not establish independent product
identity, remote server distribution, signing, or an update channel.

Build the current clean commit with a unique downstream version:

```bash
vp node downstream/tools/downstream.ts build
```

The command derives a version such as `0.0.33-downstream.20260808.1035.2629ed29330a`, creates a detached temporary worktree, installs the pinned dependencies, reuses T3's release-version alignment script, and runs the existing host artifact builder. Output lands in `release/downstream/`, and the temporary worktree is removed even when the build fails.

The artifact build deliberately removes `T3CODE_DESKTOP_UPDATE_REPOSITORY` and `GITHUB_REPOSITORY` from its build environment. This prevents an installed downstream build from replacing itself with an official or incomplete fork release. A fork update channel must publish matching desktop artifacts and the exact server/CLI version before enabling updates.

For a compile-only check, use `vp run build:desktop`. For development, use the existing `vp run dev` or `vp run dev:desktop` commands instead of producing an installer.

## Removing a Downstream Change

When upstream ships equivalent behavior, restore its normal files, remove the redundant overlay
files and active change record during the next roll, and keep a regression test only when it still
protects behavior that upstream does not already cover. A downstream-only deletion of an upstream
file remains unsupported by the copy-only overlay.

## What Git Already Handles

Normal commits are the downstream patch set, merge ancestry records accepted upstream baselines, and CI validates the integrated tree. The downstream commands only automate repeatable setup and isolated packaging. Keep `downstream/t3code/` limited to downstream-owned files; do not copy the whole upstream tree or add generated patch files, a baseline file, automatic conflict resolution, or automatic merging.
