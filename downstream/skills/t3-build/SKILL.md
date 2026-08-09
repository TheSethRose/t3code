---
name: t3-build
description: Build or reuse and fully verify a local T3 Code downstream DMG for the exact current clean commit. Use when the user invokes $t3-build or asks to build, rebuild, package, or produce a downstream desktop installer or DMG. Never sync upstream, change source, publish, or install the artifact.
---

# T3 Build

Produce one verified DMG for the exact current commit. Reuse a matching valid artifact instead of
rebuilding it.

## Authority

Explicit invocation authorizes local artifact inspection and `vp node downstream/tools/downstream.ts
build`, which writes generated files under `release/downstream/`. It does not authorize source
changes, stashing intended work, syncing, committing, pushing, publishing, uploading, or installing.

Read `AGENTS.md`, `downstream/t3code/AGENTS.md`, `downstream/README.md`, and
`downstream/docs/release-and-distribution.md` before building.

## 1. Prove the Candidate

Require a clean worktree because the builder packages committed `HEAD`; stop rather than hiding work
in a stash. Record the branch and full SHA, then run:

```bash
vp node downstream/tools/downstream.ts verify
git rev-parse HEAD
git rev-parse --short=12 HEAD
```

Do not invoke `$t3-sync`. Build the commit the user selected.

## 2. Reuse or Build Once

Look under `release/downstream/` for the newest DMG whose downstream version contains the exact
12-character `HEAD` SHA. Reuse it only if all validation below passes. Otherwise run once:

```bash
vp node downstream/tools/downstream.ts build
```

Do not run `vp run build:desktop` first; the isolated builder already installs pinned dependencies,
aligns versions, and runs the desktop build.

## 3. Validate the DMG

For the selected exact-commit artifact:

1. Run `hdiutil verify <dmg>`.
2. Mount it read-only and without opening it at a new `mktemp -d` mount point.
3. Require exactly one `.app` and run `codesign --verify --deep --strict --verbose=2 <app>`.
4. Read `CFBundleShortVersionString` and `CFBundleVersion`; require the downstream version and exact
   commit encoded by the artifact.
5. Inspect the executable architecture and signing identity.
6. Detach the exact mounted image, remove only the temporary mount directory, and run
   `shasum -a 256 <dmg>`.

Image verification alone does not prove the app's resource seal. Report Apple Development signing
and lack of notarization plainly when applicable.

## 4. Report

Report reused or rebuilt, source SHA, version, architecture, absolute DMG path, checksum, image
verification, strict signature result, and signing/notarization status. Stop with the source and
artifact intact if the worktree is dirty, build fails, no exact artifact appears, mounting is
ambiguous, or any validation fails.
