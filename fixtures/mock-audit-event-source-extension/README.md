# @project-vault/mock-audit-event-source-extension

A self-contained, in-process mock audit-event-source extension, built to exercise Story 23.8's
`AuditEventSourceHost` hook end-to-end — through the real `loadExtension()` →
`buildHostServices()` → `hooksFactory(host)` boot path — **without ever standing up a real
third-party extension** (e.g. CentralizeMe's module pack).

## What this is (and is not)

- Unlike every prior hook fixture in this repo (`mock-sso-extension`, `mock-envelope-extension`,
  `mock-capability-gate-extension`), `audit-event-source` is the FIRST **inverted** hook: PV
  implements `writeAuditEvent()` and hands this extension a real, callable `host` at load time.
  This fixture implements nothing PV calls — it calls something PV implements.
- Its `hooksFactory(host)` stashes the received `host` in module state and returns `{}` (no
  `ExtensionHooks` field — `audit-event-source` never belonged there, see
  `register-extension.ts`'s `ExtensionHooks` doc comment).
- `triggerAuditWrite(input)` is a test-only export that calls the real, captured
  `host.auditEventSource.writeAuditEvent(input)` — **only when a test calls it**, never on every
  boot (that would write a real audit row on every process start and pollute every other test's
  DB state).
- It declares only `audit-event-source` in its manifest `capabilities` — proving this hook is
  independently registrable, the same "pure single-hook fixture" precedent
  `mock-capability-gate-extension` established.

## Loading it

Point `VAULT_EXTENSIONS_PACKAGE` at this package's name (after building it, so `dist/index.js`
resolves):

```bash
pnpm --filter @project-vault/mock-audit-event-source-extension build
VAULT_EXTENSIONS_PACKAGE=@project-vault/mock-audit-event-source-extension pnpm --filter @project-vault/api dev
```

The API's boot sequence (`apps/api/src/app.ts` → `loadExtension()` → `buildHostServices()` →
`hooksFactory(host)`) picks it up exactly like any other extension.

## Real-boot integration test

`apps/api/src/__tests__/audit-event-source-boot-integration.test.ts` boots the REAL `createApp()`
with this fixture as `VAULT_EXTENSIONS_PACKAGE`, then imports the fixture module (module
singleton — the spec runs in the same Node process as the dynamically-imported fixture, the same
technique `mock-capability-gate-extension`'s own boot-integration test uses) and calls
`triggerAuditWrite()` to drive a real write through the real host wiring, asserting the resulting
row exists with `actor_type = 'extension'` and `payload->>'extensionName'` matching this fixture's
manifest name.

## Production-safety

**This package's name must never appear in any production `VAULT_EXTENSIONS_PACKAGE` default,
example config, or deploy manifest.**
`apps/api/src/__tests__/mock-extension-not-in-production.test.ts` enforces this with a
repo-wide, grep-based check, alongside the other three reference fixture extensions.
