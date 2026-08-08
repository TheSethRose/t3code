# Services and Security

The downstream inherits code that can connect to T3 Code servers, provider CLIs, source-control
services, hosted clients, T3 Connect, identity providers, and platform release systems. Having the
source does not make upstream-operated infrastructure part of the downstream trust boundary.

Use the upstream [environment authentication profile](../../docs/internals/environment-auth.md),
[remote architecture](../../docs/internals/remote.md), and
[T3 Connect architecture](../../docs/internals/t3-connect.md) as the implementation references.
This document records the downstream ownership rules around them.

## Environment Authentication

One T3 server is the execution boundary for providers, terminals, Git, and filesystem access.
Pairing credentials grant access to that environment, so preserve upstream's scoped authorization,
short-lived WebSocket ticket, session-revocation, and explicit network-exposure behavior.

Do not weaken authentication because a build is private or used over a tailnet. A private network
reduces exposure but does not replace environment authorization. Treat pairing URLs and tokens as
credentials and keep them out of commits, screenshots, logs, query parameters, and build artifacts.

## Hosted Web Clients

`https://app.t3.codes` is an upstream-operated static client. Hosted pairing still connects directly
from the browser to the environment; the hosted site does not proxy application traffic. Browser
mixed-content rules require HTTPS/WSS backends from an HTTPS-hosted client, as documented in upstream
[Remote Access](../../docs/user/remote-access.md).

An official hosted client may run a different version and does not promise support for downstream-only
contracts or UI. Treat it as an external compatibility target, not the downstream control surface.
A downstream-hosted client needs its own domain, deployment, configuration, privacy policy, and
version coordination.

## T3 Connect and Identity

T3 Connect uses upstream-controlled relay, Clerk, domain, database, observability, tunnel, and mobile
configuration when pointed at official production values. The downstream does not deploy to or
administer those resources.

Before enabling T3 Connect in a distributed downstream build, choose one of two documented states:

- disabled, with direct, Tailscale, or SSH access remaining available; or
- self-hosted, with downstream-owned accounts, domains, credentials, data retention, monitoring, and
  incident response.

Do not mix a downstream relay with an upstream identity tenant unless that exact trust relationship
has been configured and verified. Public client identifiers may be embedded in applications, but
private keys, API tokens, signing credentials, and service secrets stay in their owning deployment
environment.

## Build Configuration

The local downstream artifact builder may make repository-root `.env` configuration available in its
temporary worktree because the inherited build uses it for optional public service configuration.
Review every enabled value before distribution. A build must not accidentally ship an official
production endpoint, a maintainer's private environment, or a secret-bearing configuration because
it happened to exist on the build machine.

Use a clean release environment with an explicit allowlist of required public build variables. Keep
signing credentials and deployment tokens in the release platform's secret store, scope them to the
downstream repository and environment, and never write their values into change records or docs.

## Provider Credentials

Providers run on the server machine and use that environment's installed CLI credentials. Clients
receive status and normalized runtime events, not provider credential files. A downstream provider
must preserve that boundary, redact sensitive environment values, and keep provider-native payloads
out of orchestration events unless the shared contract explicitly requires them.

See [Provider Architecture](providers.md) for the driver lifecycle and client exposure checklist.

## Release and Workflow Safety

Inherited workflows include upstream publication and deployment jobs. Before enabling Actions with
downstream credentials, disable or gate every job that can publish npm packages, GitHub releases,
desktop update metadata, hosted web deployments, relay infrastructure, EAS builds, app-store builds,
or announcements. See [Release and Distribution](release-and-distribution.md).

Release provenance should identify the accepted upstream nightly, downstream commit, build workflow,
platform, architecture, signing identity, and artifact checksum. A nightly tag is trusted only after
it is confirmed as an upstream-published tag on the expected history.

## Security Review Triggers

Require a focused security review when a downstream change:

- adds an RPC method, authorization scope, pairing flow, or credential store;
- exposes a new listener, endpoint, tunnel, or hosted service;
- executes provider, shell, Git, or filesystem input from a client;
- changes secret redaction, logs, telemetry, or persisted session data;
- changes desktop protocols, signing, updater feeds, or release permissions;
- introduces a new third-party service that receives project, thread, identity, or operational data.

The review should name the trust boundary, validation point, stored data, failure behavior, and
revocation or recovery path. Security controls that prevent credential exposure or data loss are not
optional simplifications.
