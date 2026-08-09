# Product Boundary

The downstream repository integrates selected fork-only behavior with exact `upstream/main`
baselines. Upstream remains the source for the core server, contracts, clients, and release machinery;
`origin/main` is the tested downstream product branch. See the upstream
[architecture overview](../../docs/internals/overview.md) for the runtime model and
[`downstream/README.md`](../README.md) for the Git workflow.

## Current Boundary

The current downstream control layer can merge the fetched upstream tip, verify its repository instructions, and
build a host-platform desktop artifact from a clean commit. It does not yet establish an independent
public product identity or distribution system.

| Surface    | Current downstream status                                                                | Boundary                                                                                                                                    |
| ---------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Server     | Built into the local desktop artifact and available from a source checkout.              | No matching downstream CLI package is published for remote installation or self-update.                                                     |
| Web        | Built from the integrated source tree and served by the local server or desktop backend. | `app.t3.codes` is an upstream-operated client and is not a downstream release surface.                                                      |
| Desktop    | A host-platform artifact can be built with `downstream.ts build`.                        | The package still inherits upstream application identity and must not be presented as side-by-side safe.                                    |
| Mobile     | Source changes can be made and tested in the existing React Native app.                  | No downstream mobile bundle identity, signing setup, store listing, or update channel exists.                                               |
| T3 Connect | The source remains in the repository.                                                    | The production relay, Clerk tenant, domains, and hosted services are upstream-operated unless the downstream explicitly provisions its own. |

Until identity and distribution are separated, treat downstream installers as private replacement
builds for controlled testing. Do not promise that they can coexist with an official T3 Code install,
and do not point users at upstream update actions to maintain a downstream environment.

## Multi-Surface Rule

The upstream product has web, desktop, and mobile clients, with shared client behavior in
`packages/client-runtime`. A downstream feature must make an explicit decision for every applicable
surface:

- Web includes both the locally served app and any downstream-hosted web build.
- Desktop wraps web and adds process, filesystem, updater, protocol, and operating-system identity.
- Mobile has separate React Native navigation and presentation.
- Local, direct remote, relay, Tailscale, and desktop-managed SSH connections may expose different
  lifecycle and security behavior. The upstream [remote architecture](../../docs/internals/remote.md)
  defines those access paths.

"Not supported" is a valid decision when it is recorded in the change record and the unavailable
path fails clearly. Silent omission is not a completed feature.

## Independent Identity Gate

Before a downstream build is distributed outside controlled replacement testing, define and verify:

- a distinct product and display name;
- desktop application IDs, URL schemes, Linux desktop identity, and Windows application identity;
- separate desktop user-data and T3 home directories;
- an explicit import path if official T3 Code data should be copied;
- a downstream update repository and signing policy;
- a downstream server installation source for every remote mode that is supported;
- separate mobile bundle IDs, signing, and update channels when mobile distribution is supported.

Data import must be explicit and one-way. Sharing the live official data directory would couple two
builds with different migrations, settings, and update behavior, so it is outside the supported
boundary.

## Upstream Services

Official T3 Code websites, app stores, npm packages, identity providers, relay infrastructure, and
release channels remain upstream surfaces. Keeping source compatibility with them does not grant the
downstream control over their availability, policies, credentials, or version cadence. Any reuse must
be documented in [Services and Security](services-and-security.md) and tested as an external
dependency.
