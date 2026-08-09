# New Sidebar Archive Action

## Why

The default sidebar exposed Snooze and Settle quick actions but did not expose the existing Archive workflow. The Archive confirmation setting therefore applied only when the legacy sidebar was enabled, even though the shared archive command and archived-thread view were already available.

## Affected Surfaces

- `apps/web/src/components/Sidebar.tsx` adds the existing Archive icon between Snooze and Settle on non-running card rows.
- The existing `useThreadActions().archiveThread` callback handles the command, current-thread navigation, and archive refresh; the sidebar reports failures through its existing toast pattern.
- `apps/web/src/components/Sidebar.logic.ts` keeps the two-click decision testable without rendering the complete sidebar.
- `confirmThreadArchive` keeps the existing two-click inline confirmation behavior; disabled confirmation archives on the first click.
- Web and desktop receive the behavior because desktop uses the web client sidebar. Remote sessions using the same client sidebar are covered as well.
- Settled and snoozed compact rows, the legacy sidebar, mobile, and archive storage/state handling are unchanged.

## Overlay Files

- `apps/web/src/components/Sidebar.tsx`
- `apps/web/src/components/Sidebar.logic.test.ts`
- `apps/web/src/components/Sidebar.logic.ts`

## Validation

```bash
(cd apps/web && vp test run --passWithNoTests --project unit src/components/Sidebar.logic.test.ts)
(cd apps/web && vp run typecheck)
vp node downstream/tools/downstream.test.ts
vp exec tsgo -p downstream/tools/tsconfig.json --noEmit
vp node downstream/tools/downstream.ts verify
git diff --check
```

The focused validation must prove the web client typechecks and the downstream overlay remains byte-identical to the normal source. Manual UI verification should confirm the icon appears between Snooze and Settle, immediate archive works when confirmation is disabled, and the first/second clicks work when confirmation is enabled.

## Removal Condition

Remove this downstream change, its overlay, and this record when upstream exposes the existing Archive workflow in the default sidebar with the same icon placement, non-running guard, and `confirmThreadArchive` behavior.
