# Downstream Documentation

These documents describe the parts of this fork that differ from, depend on, or place additional
constraints on upstream T3 Code. The upstream [`docs/`](../../docs/README.md) tree remains the source
of truth for T3 Code architecture and user behavior. A downstream document should link to that
source, then explain only the downstream policy or compatibility work layered on top.

## Start Here

- [Product Boundary](product-boundary.md) defines what the downstream build owns and which product
  surfaces are currently safe to distribute.
- [Compatibility](compatibility.md) defines how downstream changes remain compatible with upstream
  nightlies, stored data, and mixed client/server versions.
- [Release and Distribution](release-and-distribution.md) describes the current local artifact path
  and the work required before publishing installers or remote servers.
- [Change Lifecycle](feature-lifecycle.md) is the checklist for adding, validating, rolling, and
  eventually removing one downstream change.
- [Services and Security](services-and-security.md) records the trust boundary around pairing,
  hosted clients, T3 Connect, credentials, and build configuration.
- [Provider Architecture](providers.md) maps the provider driver extension points and gives the
  downstream provider checklist.

The operational commands for bootstrapping, syncing upstream, resolving conflicts, and building a
local installer stay in [`downstream/README.md`](../README.md). `$t3-plan` captures new work in
GitHub issues; `downstream/changes/` lists completed, active fork-only behavior. Git history is the
archive after removal.

## Documentation Rules

Downstream docs must distinguish current behavior from a required future state. They must not claim
that an installer, update channel, hosted client, relay, mobile build, or server package exists until
that path has been built and verified.

When upstream changes an architecture described here, update the downstream document during the same
upstream sync. Prefer linking to upstream documentation over copying it. Keep exact validation commands
in the relevant change record so a sync can be checked without guessing which tests still matter.
