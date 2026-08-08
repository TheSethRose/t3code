# Downstream Update Track

Status: planned
Priority: first
Reference: [Release and Distribution](../release-and-distribution.md)

## Goal

Add a third "Downstream" option to the desktop Settings → About → Update track selector. When
selected, the app checks for updates against this fork's GitHub releases
(`https://github.com/TheSethRose/t3code`) instead of the official
`pingdotgg/t3code` feed baked into the installer. Selecting Stable or Nightly restores the baked
feed.

## Current Behavior

- The update feed is chosen at build time. `scripts/build-desktop-artifact.ts`
  `resolveGitHubPublishConfig` reads `T3CODE_DESKTOP_UPDATE_REPOSITORY` or `GITHUB_REPOSITORY` and
  bakes the result into `app-update.yml` inside the installer.
- At runtime `apps/desktop/src/updates/DesktopUpdates.ts` reads `app-update.yml` into
  `appUpdateYmlConfigRef`; `hasUpdateFeedConfig` derives from it. Without a feed, auto-update is
  disabled with reason "no update feed is configured" and `configure()` returns before wiring the
  updater or the pollers.
- `DesktopUpdateChannel` is `"latest" | "nightly"` in `packages/contracts/src/ipc.ts`
  (`DesktopUpdateChannelSchema` is the same literals). The choice persists through
  `DesktopAppSettings.updateChannel` and `updateChannelConfiguredByUser`.
- `applyAutoUpdaterChannel` maps the channel to electron-updater's `setChannel`,
  `setAllowPrerelease`, `setAllowDowngrade`, and `setFullChangelog`. `setChannel` persists first,
  blocks while a check/download/install is live, then re-checks.
- The Settings UI select lives in `apps/web/src/components/settings/SettingsPanels.tsx`
  (AboutVersionSection, visible only when `window.desktopBridge` exists).
- The downstream artifact build (`downstream/tools/downstream.ts build`) deliberately deletes
  `T3CODE_DESKTOP_UPDATE_REPOSITORY` and `GITHUB_REPOSITORY` from its environment, so downstream
  installers carry no feed and never replace themselves with an official or incomplete fork release.
  Release and Distribution therefore does not yet claim remote self-update as supported.

## Core Decision

Make "downstream" a third `DesktopUpdateChannel` whose feed is a runtime override, not a build-time
bake. The updater already supports `setFeedURL` (used today only for the mock feed). Selecting
Downstream calls `setFeedURL({ provider: "github", owner: "TheSethRose", repo: "t3code" })`;
selecting Stable or Nightly calls `setFeedURL` again with the baked config held in
`appUpdateYmlConfigRef`. This keeps one installer able to flip between the official and fork feeds
and avoids touching `resolveGitHubPublishConfig` or the upstream publish path.

Two consequences drive the implementation:

1. A downstream build has no baked feed, so the current `configure()` early-return on
   `!enabled` would never install the fork feed. The downstream track must be allowed to configure
   the updater from the no-feed state, both at startup (persisted channel is "downstream") and when
   the user switches to it later.
2. Fork versions like `0.0.33-downstream.20260808.1035.<sha>` already classify as the "latest"
   channel via `resolveDesktopUpdateChannel` (only `-nightly.` maps to nightly), so the fork feed
   needs no extra channel handling for the first version. A fork nightly sub-track is deferred until
   the fork publishes nightly manifests.

## Minimum Implementation

### 1. Contracts

- `packages/contracts/src/ipc.ts`: add `"downstream"` to the `DesktopUpdateChannel` type and to
  `DesktopUpdateChannelSchema`. This is an additive literal; old peers decode `"latest"` and
  `"nightly"` unchanged.
- Mixed-version fallback: an old desktop receiving `"downstream"` from a newer web client must not
  crash. Decide the decode boundary when implementing; if the desktop IPC schema rejects the value,
  the web select keeps its current selection and reports a channel-change failure instead of
  leaving the UI in an inconsistent state.

### 2. Desktop runtime

- `apps/desktop/src/updates/updateChannels.ts`: `resolveDefaultDesktopUpdateChannel` must never
  return `"downstream"`. The default stays `latest`/`nightly` derived from the installed version, so
  no user is silently moved to the fork feed.
- `apps/desktop/src/updates/DesktopUpdates.ts`:
  - Add a fork-feed constant `{ provider: "github", owner: "TheSethRose", repo: "t3code" }`.
  - `applyAutoUpdaterChannel`: branch `"downstream"` to `setFeedURL(forkFeed)` plus the same
    allow-prerelease/allow-downgrade handling the version class requires; branch `"latest"` and
    `"nightly"` to restore the baked feed via `setFeedURL` from `appUpdateYmlConfigRef` before
    applying the existing channel flags. Restoring means mapping the parsed yml record back into an
    `ElectronUpdaterFeedUrl` (provider/owner/repo or generic url).
  - `configure()`: when the persisted `updateChannel` is `"downstream"`, do not early-return on a
    missing baked feed; install the fork feed and proceed with listeners and pollers.
  - `setChannel()`: when switching to `"downstream"` from a no-feed, unconfigured state, initialize
    the updater (feed, listeners, pollers) instead of short-circuiting on `!enabled`. The existing
    active-action guard already blocks channel changes during check/download/install.
  - The disabled-reason path (`getAutoUpdateDisabledReason`, `hasUpdateFeedConfig`) must not report
    "no update feed configured" when the active or requested channel is `"downstream"`.
  - `createBaseUpdateState`/`createInitialDesktopUpdateState` continue to carry the channel through
    unchanged; web state needs no new fields.
- `apps/desktop/src/settings/DesktopAppSettings.ts`: persistence already stores `updateChannel`
  through the schema; no structural change expected beyond the new literal. Verify the legacy
  `updateChannelConfiguredByUser` migration still applies.

### 3. Settings UI

- `apps/web/src/components/settings/SettingsPanels.tsx` (AboutVersionSection): add a "Downstream"
  item to the Update track `Select` and the label mapping, with a description that states the feed
  points at the fork repository and that switching back to Stable or Nightly returns to the
  official feed. Keep the desktop-bridge gate; the hosted web app does not get a downstream track.
- `apps/web/src/state/desktopUpdate.ts` and `desktopUpdate.logic.ts` are channel-agnostic; confirm
  no change is required.

### 4. Build and release gating

- Do not change `scripts/build-desktop-artifact.ts`. Official builds keep their baked feed;
  `downstream.ts build` keeps stripping the update env vars so a downstream installer never
  silently inherits an official or incomplete fork feed.
- The Downstream track is only truthful after this fork publishes GitHub releases carrying the
  electron-updater manifests (`latest.yml`, `latest-mac.yml`, `latest-linux.yml`, `latest.yml` per
  platform) and a matching server/CLI version, per [Release and Distribution](../release-and-
  distribution.md). Until then the track must surface an honest "no update available" or disabled
  state, never a phantom feed.

## Expected Implementation Surfaces

- `packages/contracts/src/ipc.ts` and its focused schema test
- `apps/desktop/src/updates/DesktopUpdates.ts` and `DesktopUpdates.test.ts`
- `apps/desktop/src/updates/updateChannels.ts` and its test
- `apps/desktop/src/settings/DesktopAppSettings.ts` and its test, only if the literal needs it
- `apps/web/src/components/settings/SettingsPanels.tsx` and its focused test
- `downstream/t3code/` overlays for every changed file
- one active `downstream/changes/` record while the deviation differs from upstream
- a note in `docs/release-and-distribution.md` or this fork's release runbook only when the fork
  starts publishing update manifests

## Validation

Focused automated coverage must prove:

- the `"downstream"` literal decodes and old peers still decode `"latest"`/`"nightly"`
- the default channel is never `"downstream"`
- `setChannel("downstream")` switches the feed to the fork, persists, and re-checks
- switching back to `"latest"`/`"nightly"` restores the baked feed
- a no-feed build can configure and check updates once the downstream track is active
- channel changes are still rejected while an update action is live
- the Settings select renders and submits all three tracks

Then the downstream control-plane checks:

```bash
vp node --test downstream/tools/downstream.test.ts
vp exec tsgo -p downstream/tools/tsconfig.json --noEmit
vp node downstream/tools/downstream.ts verify
vp run build:desktop
```

Final manual validation: package a no-feed downstream build, open Settings → About, select
Downstream, confirm the check hits the fork feed (logs/network), then switch back to Stable and
confirm the official feed path. The same installer must never download an official update while on
the Downstream track or a fork update while on Stable/Nightly.

## Done When

- Settings → About → Update track offers Stable, Nightly, and Downstream on the desktop surface.
- Downstream checks `TheSethRose/t3code` releases; Stable and Nightly keep using the baked feed.
- A no-feed downstream build can opt into updates by selecting the Downstream track.
- Switching tracks mid-download is impossible, and every switch back restores the prior feed.
- The state reported to the user never lies about which repository it checked.

## Deliberately Excluded

- Baking the fork feed at build time; the runtime switch keeps one installer able to flip and the
  downstream build safe from silent feed inheritance.
- A fork nightly sub-track until the fork publishes nightly channel manifests.
- A downstream track on the hosted web app or mobile.
- Publishing fork releases, signing, or update manifests; that work stays in Release and
  Distribution.
