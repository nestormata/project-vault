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

| Org id                       | `onCheckCapability` result                                 | Intended scenario                                         |
| ---------------------------- | ---------------------------------------------------------- | --------------------------------------------------------- |
| `fixture-org-permitted`      | `{ permitted: true }`                                      | An entitled org — publish succeeds, public page reads.    |
| `fixture-org-upgraded`       | `{ permitted: true }`                                      | The "post-upgrade" org for the Priya persona journey.     |
| `fixture-org-throw`          | throws synchronously                                       | Exercises AC-11's fail-closed-on-throw path.              |
| `fixture-org-hang`           | never resolves                                             | Exercises AC-11's fail-closed-on-timeout path.            |
| `fixture-org-garbage`        | resolves a malformed decision                              | Exercises AC-12's fail-closed-on-malformed-decision path. |
| any other org id (or `null`) | `{ permitted: false, reasonCode: 'fixture_not_entitled' }` | An org on a restricted plan — the common denial case.     |

## Loading it

Point `VAULT_EXTENSIONS_PACKAGE` at this package's name (after building it, so `dist/index.js`
resolves):

```bash
pnpm --filter @project-vault/mock-capability-gate-extension build
VAULT_EXTENSIONS_PACKAGE=@project-vault/mock-capability-gate-extension pnpm --filter @project-vault/api dev
```

The API's boot sequence (`apps/api/src/app.ts` → `loadExtension()` →
`wireExtensionCapabilityGate()`) picks it up exactly like any other extension.

## Capability gating (Story 23.3 Task 14) — what any real extension author needs to know

No standalone "extension-authoring docs" file exists in this repo yet — this section is that
content's interim home until one does, since a real, non-fixture extension implementing
`CapabilityGate` needs to know all of the following before writing an `onCheckCapability()`:

- **PV's caching contract (AC-16):** PV never caches or memoizes a gate decision — every gated
  check invokes `onCheckCapability()`, with no per-request memo, no cross-request cache, no TTL,
  and no `Map` keyed by `(orgId, capability)` holding a decision anywhere in `apps/api`. This means
  an entitlement downgrade takes effect on the very next request, with no restart, no cache flush,
  and no waiting period — but it also means your extension owns 100% of its own staleness/caching
  strategy. If your real entitlement source is slow or rate-limited, you must cache on your side of
  the hook, inside `onCheckCapability()`, where you also own the invalidation bound.
- **The fail-closed rule, verbatim:** _"A registered gate that throws, rejects, times out, or
  returns a malformed decision FAILS CLOSED for that capability check —
  `403 capability_denied` with `reasonCode: 'gate_unavailable'` (collapsed to the route's own
  uniform failure response on unauthenticated surfaces)."_ Registering a gate is an explicit
  operator declaration that an external policy layer governs the instance; once declared, an
  unanswerable check is treated as an _unknown_, never as a permission.
- **`message` is not localized, and cannot be:** `CapabilityGateContext` carries no `locale` field
  — a French-locale PV user (Story 15.1) will see whatever single language your extension
  hard-codes into `message`. Do not claim otherwise in your own docs; PV's own fallback message is
  the only localized string in this flow.
- **Quota is explicitly out of scope:** this hook answers exactly one question — "may this
  organization use capability X at all?" (entitlement) — never "may this org create its 51st
  secret" (quota). `CapabilityGateContext` carries no resource id, requested count, current usage,
  or HTTP method, so quota enforcement cannot be expressed through this hook shape at all.
- **Story 23.7 — `GET /api/v1/capabilities` exists, and it is booleans only.** PV's `apps/web`
  status-page screen (and any future screen that wants to cosmetically gate a control on your
  entitlement decision) reads your gate's answer through this one authenticated, org-scoped
  route — never by calling your extension directly. The response shape is
  `{ capabilities: Record<CapabilityIdValue, boolean> }`: PV's own `.permitted` boolean, per
  registered `CapabilityId`, and nothing else. Your `message`/`reasonCode` values are **never**
  surfaced through this endpoint — they only ever reach a user via the existing `403
capability_denied` response on an actual denied mutating request. Do not rely on this endpoint
  as a second distribution channel for your extension's own denial text.

## Recovery runbook (Story 23.3 AC-13)

There is deliberately no break-glass switch for a broken capability gate. To recover from one:

> _"To recover from a broken capability gate, unset `VAULT_EXTENSIONS_PACKAGE` and restart the
> API. The instance returns to PV's default ungated behavior. There is no partial bypass — this
> is deliberate. **Understand the cost before doing it:** `ExtensionHooks` is one bag per
> extension package, so this also disables every other hook that package provides — SSO login,
> notification channels, UI panels, and audit fanout. Local login is unaffected and cannot be
> removed, so you will not be locked out. This is a wider outage accepted deliberately during an
> incident, not a like-for-like swap."_

## Production-safety

**This package's name must never appear in any production `VAULT_EXTENSIONS_PACKAGE` default,
example config, or deploy manifest.**
`apps/api/src/__tests__/mock-extension-not-in-production.test.ts` enforces this with a
repo-wide, grep-based check, alongside `@project-vault/mock-sso-extension` and
`@project-vault/mock-envelope-extension`.
