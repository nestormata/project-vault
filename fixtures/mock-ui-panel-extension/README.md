# @project-vault/mock-ui-panel-extension

A self-contained, in-process mock UI-panel extension, built to exercise Story 25.1's `UIPanel`
hook end-to-end through the real boot path (`loadExtension()` -> `GET
/api/v1/extensions/panels/:slot` -> `onRenderPanel()`) — **without ever standing up
CentralizeMe's real `access-group/ui-panel.ts`**, which cannot render meaningfully until Story
25.3 adds a `resourceId` field to `UIPanelContext`.

## What this is (and is not)

- It implements the `UIPanel` contract published by `@project-vault/extension-api`:
  `onRenderPanel(context: UIPanelContext): Promise<UIPanelResult>`.
- It declares only the `ui-panel` capability. It does not implement any other hook.
- `onRenderPanel()`'s result is driven purely by the requested `slot`, deterministically, with no
  network call and no real content.

## Fixture slot values

| Slot value          | `onRenderPanel` result                          | Intended scenario                    |
| -------------------- | ------------------------------------------------ | -------------------------------------- |
| `group`               | `{ html: '<html>...Mock panel for slot "group"...' }` | AC1/AC4 happy path. |
| `fixture-throw`        | throws synchronously                              | AC3 fail-closed-on-throw.              |
| `fixture-hang`         | never resolves                                    | AC3 fail-closed-on-timeout.            |
| `fixture-garbage`      | resolves `{ html: 42 }` (malformed)               | AC3 fail-closed-on-malformed-result.   |

**Story 25.2 AC6 update:** this fixture's manifest now declares all four slots above via
`uiPanelSlots: ['group', 'fixture-throw', 'fixture-hang', 'fixture-garbage']`. The host
(`apps/api/src/lib/extension-panel.ts`'s `resolveKnownUiPanelSlots()`) derives its known-slots
allowlist from this manifest dynamically, so every slot in the table is reachable through the
real HTTP route directly — no source-editing workaround needed. To manually verify AC3's
degraded paths against a real running stack, just request `GET
/api/v1/extensions/panels/fixture-throw` (or `-hang` / `-garbage`) once this fixture is loaded.

## Loading it

Point `VAULT_EXTENSIONS_PACKAGE` at this package's name (after building it, so `dist/index.js`
resolves):

```bash
pnpm --filter @project-vault/mock-ui-panel-extension build
VAULT_EXTENSIONS_PACKAGE=@project-vault/mock-ui-panel-extension pnpm --filter @project-vault/api dev
```

The API's boot sequence (`apps/api/src/app.ts` -> `loadExtension()`) picks it up exactly like any
other extension. Once loaded, `GET /api/v1/extensions/nav` reports `{ uiPanelSlot: 'group' }`, the
app shell's nav bar shows the generic "Extension" entry, and `GET
/api/v1/extensions/panels/group` (and the corresponding `/extensions/panels/group` web page)
render this fixture's static HTML fragment inside the sandboxed iframe.

## Production-safety

**This package's name must never appear in any production `VAULT_EXTENSIONS_PACKAGE` default,
example config, or deploy manifest.**
`apps/api/src/__tests__/mock-extension-not-in-production.test.ts` enforces this with a
repo-wide, grep-based check, alongside the other reference fixture extensions.
