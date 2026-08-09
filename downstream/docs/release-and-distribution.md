# Release and Distribution

Upstream T3 Code publishes a coordinated CLI package, desktop artifacts, updater metadata, hosted web
client, and optional service infrastructure. Its release graph is documented in the upstream
[release runbook](../../docs/operations/release.md). The downstream currently supports a smaller
local artifact workflow and must not inherit upstream publication destinations by accident.

## Current Build Path

From a clean accepted commit, invoke:

```text
$t3-build
```

The skill reuses a valid exact-commit artifact when possible; otherwise it runs
`vp node downstream/tools/downstream.ts build`. The command creates a detached
temporary worktree, aligns release package versions to a unique downstream version, installs pinned
dependencies, invokes the existing host artifact builder once, and copies output to
`release/downstream/`. It removes `T3CODE_DESKTOP_UPDATE_REPOSITORY` and
`GITHUB_REPOSITORY` from the artifact build environment, so the resulting installer does not receive
an official or incomplete fork updater feed.

This is a host-platform build, not a full release matrix. Because the output directory may contain
artifacts from earlier runs, identify the files produced by the current invocation before handing
them off. A publication workflow should use a clean, version-specific artifact directory.

## What Is Not Published

The local downstream build does not publish:

- an exact downstream `t3` server package;
- GitHub updater releases and channel manifests;
- signed or notarized artifacts unless the host build is configured for them;
- a hosted downstream web client;
- relay infrastructure or production identity configuration;
- downstream mobile builds or store releases.

Because the server package is missing, an external server cannot resolve a downstream desktop
version through the upstream `npx t3@<version>` path. Do not describe remote self-update as supported
until a matching package or verified artifact installer exists.

## Upstream Workflow Boundary

The inherited GitHub workflows contain upstream production behavior, including scheduled releases,
npm publication, GitHub Releases, hosted web deployment, relay deployment, mobile EAS builds, and
release announcements. A downstream repository must disable or explicitly gate those jobs before
enabling Actions with production credentials.

Ordinary CI may continue to validate the integrated tree. Publication should use a separate
downstream workflow with its own manual trigger, destinations, environments, signing identities, and
permissions. Never use missing credentials as the release guard.

## Distribution Readiness Gates

### Desktop

Before distributing a desktop installer, verify a distinct application identity, isolated data
paths, signing policy, URL protocol ownership, install/uninstall behavior, and side-by-side behavior
with official T3 Code. Check startup, the bundled server, provider discovery, local projects,
settings persistence, and uninstall without touching the official installation.

### Server

Before supporting external or remote servers, choose a downstream-owned installation source. The
client's manual command and launcher-managed update must install that source rather than assuming the
upstream `t3` package. Publish the server before exposing a client with that exact version, matching
the ordering guarantee in the upstream release runbook.

### Hosted Web and Relay

A downstream-hosted web app needs its own deployment, domains, environment configuration, and direct
pairing compatibility. A downstream relay needs its own Cloudflare, identity-provider, database,
observability, domain, and signing configuration. The upstream
[T3 Connect architecture](../../docs/internals/t3-connect.md) remains the implementation reference;
its production resources are not downstream release targets.

### Mobile

Mobile distribution needs downstream bundle identifiers, signing credentials, EAS project and
environment configuration, deep-link ownership, push and widget decisions, and a matching server
compatibility policy. Follow [`apps/mobile/README.md`](../../apps/mobile/README.md) for the upstream
build variants, then document every downstream override here before publishing.

## Release Sequence

Once all applicable gates exist, use this order:

1. Accept a tested `upstream/main` commit into downstream `main`.
2. Run every active change record and downstream control-plane check.
3. Build from the exact clean commit and record its upstream baseline and downstream commit.
4. Publish the exact matching server distribution before clients that request it.
5. Build and sign platform artifacts in clean, version-specific jobs.
6. Publish updater metadata only after every referenced artifact exists.
7. Move hosted or mobile channels only after the matching server is available.
8. Install the released artifact on a clean test profile and verify startup, pairing, one completed
   turn, restart, and rollback or manual recovery.

Never publish directly from an upstream sync branch. `origin/main` is the accepted downstream product
and remains the release source.
