# Downstream Provider Registry

## Why

Pi and generic ACP are independent providers, but registering either one changes the same provider
settings contract, driver list, icons, labels, and provider pickers. This record owns those shared
overlays so each full file has one downstream owner while both provider records remain removable.

## Affected Surfaces

- Provider settings and built-in driver registration on the server.
- Provider labels, icons, and selection on web, desktop, and mobile.

## Overlay Files

- `apps/mobile/src/components/ProviderIcon.tsx`
- `apps/mobile/src/lib/modelOptions.ts`
- `apps/server/src/provider/builtInDrivers.ts`
- `apps/web/src/components/chat/providerIconUtils.ts`
- `apps/web/src/components/settings/providerDriverMeta.ts`
- `apps/web/src/session-logic.ts`
- `packages/contracts/src/settings.ts`

## Validation

```bash
(cd packages/contracts && vp run typecheck)
(cd apps/server && vp run typecheck)
(cd apps/web && vp run typecheck)
(cd apps/mobile && vp run typecheck)
vp node downstream/tools/downstream.test.ts
vp node downstream/tools/downstream.ts verify
```

## Removal Condition

Remove this record when upstream owns every shared registration and picker surface listed above, or
when only one downstream provider remains and its record can own the files directly.
