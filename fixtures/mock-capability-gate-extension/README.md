# @project-vault/mock-capability-gate-extension

A self-contained, in-process mock capability-entitlement gate extension, built to exercise Story
23.3's `CapabilityGate` hook end-to-end — through the real `loadExtension()` →
`wireExtensionCapabilityGate()` boot path and the two real annotated routes
(`POST /api/v1/projects/:projectId/status-page`, `GET /api/v1/status-pages/:token`) — **without
ever standing up a real third-party entitlement/billing system** (e.g. CentralizeMe's module pack).

## What this is (and is not)

- It implements the `CapabilityGate` contract published by `@project-vault/extension-api`:
  `onCheckCapability(context: CapabilityGateContext): Promise<CapabilityDecision>`.
- It gates exactly one capability: `monitoring.public-status-page`.
- Its decision is driven from a small, deterministic, **in-memory** lookup table keyed by
  `orgId` (`PERMITTED_ORG_IDS` in `src/index.ts`) — **no network call, no real entitlement data,
  no timers**.
- It does **not** implement an auth strategy. Keeping it a pure single-hook fixture proves the
  hooks are independently registrable — a manifest may declare `capability-gate` alone.
- Its `message` values are plain, hard-coded English and are **not localized**. Per Story 23.3
  AC-4, `CapabilityGateContext` carries no `locale` field, so no extension — including this one —
  can localize `message`. Do not add localization here; it would misrepresent what the real
  contract can do.

## Fixture org ids

| Org id                     | `onCheckCapability` result                          | Intended scenario                                    |
|-----------------------------|-------------------------------------------------------|--------------------------------------------------------|
| `fixture-org-permitted`     | `{ permitted: true }`                                  | An entitled org — publish succeeds, public page reads.  |
| `fixture-org-upgraded`      | `{ permitted: true }`                                  | The "post-upgrade" org for the Priya persona journey.   |
| `fixture-org-throw`         | throws synchronously                                   | Exercises AC-11's fail-closed-on-throw path.            |
| `fixture-org-hang`          | never resolves                                         | Exercises AC-11's fail-closed-on-timeout path.          |
| `fixture-org-garbage`       | resolves a malformed decision                          | Exercises AC-12's fail-closed-on-malformed-decision path. |
| any other org id (or `null`)| `{ permitted: false, reasonCode: 'fixture_not_entitled' }` | An org on a restricted plan — the common denial case.   |

## Loading it

Point `VAULT_EXTENSIONS_PACKAGE` at this package's name (after building it, so `dist/index.js`
resolves):

```bash
pnpm --filter @project-vault/mock-capability-gate-extension build
VAULT_EXTENSIONS_PACKAGE=@project-vault/mock-capability-gate-extension pnpm --filter @project-vault/api dev
```

The API's boot sequence (`apps/api/src/app.ts` → `loadExtension()` →
`wireExtensionCapabilityGate()`) picks it up exactly like any other extension.

## Recovery runbook (Story 23.3 AC-13)

There is deliberately no break-glass switch for a broken capability gate. To recover from one:

> *"To recover from a broken capability gate, unset `VAULT_EXTENSIONS_PACKAGE` and restart the
> API. The instance returns to PV's default ungated behavior. There is no partial bypass — this
> is deliberate. **Understand the cost before doing it:** `ExtensionHooks` is one bag per
> extension package, so this also disables every other hook that package provides — SSO login,
> notification channels, UI panels, and audit fanout. Local login is unaffected and cannot be
> removed, so you will not be locked out. This is a wider outage accepted deliberately during an
> incident, not a like-for-like swap."*

## Production-safety

**This package's name must never appear in any production `VAULT_EXTENSIONS_PACKAGE` default,
example config, or deploy manifest.**
`apps/api/src/__tests__/mock-extension-not-in-production.test.ts` enforces this with a
repo-wide, grep-based check, alongside `@project-vault/mock-sso-extension` and
`@project-vault/mock-envelope-extension`.
