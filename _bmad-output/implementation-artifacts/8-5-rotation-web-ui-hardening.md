# Story 8.5: Rotation Web UI Hardening

Status: review

<!-- Ultimate context engine analysis completed 2026-07-06 — this story closes the 4 unresolved
adversarial-review findings against Story 5.4 (rotation-workflow-web-ui, `done`), bundled per
Nestor's explicit decision at the 2026-07-06 Epic 5 retro recheck (see
`_bmad-output/implementation-artifacts/epic-5-retro-2026-07-05.md`, "Addendum (2026-07-06)").
Every claim below was re-verified directly against the shipped code in this branch — not copied
from the review doc — including one additional, closely-related gap (AC-5) found during that
re-verification that the original review didn't call out by name but is the same root cause
(sealed-vault UX) in the same feature area. This story adds ZERO new backend routes, ZERO new DB
migrations, ZERO new audit events — every fix is `apps/web/**` only, following the exact
"web-only, zero apps/api diff" boundary Story 5.4 itself established (AC-27). -->

## Story

As a developer, organization admin, or incident responder using the credential rotation web UI,
I want the UI to gracefully handle a sealed vault on page load, MFA-required errors, rate-limit (429) responses, and to stop leaving a plaintext break-glass secret sitting in memory longer than necessary,
so that the four gaps Story 5.4's own adversarial review found (and shipped anyway) don't cause confusing crashes, silent failures, or unnecessary secret exposure — especially during the incident-response break-glass flow, which is the highest-blast-radius path in all of Epic 5.

*This is a hardening/bug-fix story over Story 5.4's already-shipped `apps/web/**` surface — it adds no new pages, no new routes, and no new API endpoints. It only fixes error-handling and secrets-hygiene gaps in the pages/components 5.4 already created.* [Source: `_bmad-output/implementation-artifacts/5-4-rotation-workflow-web-ui-adversarial-review.md`, `_bmad-output/implementation-artifacts/epic-5-retro-2026-07-05.md` addendum]

---

## Why this story exists (read before coding)

Story 5.4 shipped all 27 of its own acceptance criteria and passed its adversarial review's coverage step, but the review found **2 critical + 2 high** findings that were never remediated before the story was marked `done`:

1. **[critical]** AC-24 claimed the four rotation read endpoints (`GET .../rotations`, `GET .../rotations/:id`, `GET .../dependencies`, `GET .../rotations/upcoming`) "are not vault-guarded... so reads still succeed while sealed" — **this is false**. Direct inspection of `apps/api/src/plugins/vault-guard.ts` (re-confirmed for this story — see below) shows its `VAULT_GUARD_ALLOWLIST` has exactly 7 entries, none of them rotation/dependency reads, so the guard's `onRequest` hook 503s **every** rotation/dependency GET while sealed. None of Story 5.4's four `PageServerLoad` functions that call these endpoints catch a `503`.
2. **[critical]** `403 { code: 'mfa_required' }` is real on 5 of the 11 endpoints this UI wraps (initiate, break-glass, complete, resume, abandon — all `requireMfa: true`, re-confirmed below) and is never handled anywhere in the rotation UI, despite a working precedent already existing elsewhere in this exact codebase.
3. **[high]** 429 rate-limiting is enforced on every rotation mutation (30/min initiate, 10/min break-glass, 60/min checklist actions and complete, 30/min resume/abandon — re-confirmed below) and is completely unhandled in the UI. This is highest-risk on break-glass, the one flow explicitly designed to "act in seconds" during an incident.
4. **[high]** The break-glass panel's plaintext new-value field is cleared on a *successful* submit only — never on a failed submit, component teardown, or panel re-collapse — leaving a live credential value sitting in browser memory/DOM longer than necessary in a workflow explicitly used mid-incident (shoulder-surf/screen-share risk).

**Re-verification performed for this story (2026-07-06, this branch):**

- `apps/api/src/plugins/vault-guard.ts` — `VAULT_GUARD_ALLOWLIST` is still exactly `GET /health`, `GET /ready`, `POST /api/v1/vault/init`, `POST /api/v1/vault/unseal`, `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`. Nothing under `apps/api/src/modules/rotation/**` or `apps/api/src/modules/credentials/**` is allowlisted. The guard fails closed with `503 { status: 'sealed', message: 'Vault not initialized' }` for everything else.
- `apps/api/src/modules/rotation/routes.ts` — `requireMfa: true` is set on exactly 5 endpoints: initiate (`security` block ~line 419-424), break-glass (~line 557-561), complete (~line 1146-1148), resume (~line 1280-1282), abandon (~line 1338-1340). Confirm/fail/retry (`minimumRole: 'member'`, ~lines 815, 907, 1004) do **not** set `requireMfa` — this asymmetry is real and intentional server-side, not a gap to "fix" here (see AC group B's non-goal note).
- Rate limits, from the same file: `INITIATE_ROTATION_RATE_LIMIT` = `{ max: 30, timeWindowMs: 60_000 }` (line ~169); `BREAK_GLASS_RATE_LIMIT` = `{ max: 10, timeWindowMs: 60_000 }` (line ~537, deliberately tighter — code comment: *"a legitimate incident responder needs at most a handful of break-glass calls per minute"*); `checklistMutationRateLimit()` = `{ max: 60, timeWindowMs: 60_000 }` (line ~179-181) shared by confirm/fail/retry and reused for complete; `resolutionRateLimit()` (~line 1262-1263) = `{ max: 30, timeWindowMs: 60_000 }` for resume/abandon — a **distinct, tighter 30/min bucket, not the same 60/min shape as checklist/complete** (this corrects an earlier draft of this story that misstated it as 60/min; re-verify directly against `resolutionRateLimit()`'s own `return` statement, do not trust the checklist-bucket number by proximity). All 429s are produced by `enforceUserRateLimit()` in `apps/api/src/lib/route-helpers.ts` (lines 95-123), which sends exactly `reply.status(429).send({ code: 'rate_limit_exceeded', message: 'Too many authenticated requests', retryAfter: <seconds> })` — this shape is **already** representable by the existing `ApiFailure` type in `apps/web/src/lib/api/client.ts` (`retryAfter?: number` field already exists there), so **no new shared-type work is needed**, only new UI branches that read `error.body?.retryAfter`.
- `apps/web/src/lib/components/rotations/BreakGlassPanel.svelte` (current, as shipped) — line 50: `newValue = ''` runs **only** inside the `try` block's success path, immediately after `breakGlassRotation(...)` resolves. There is no `onDestroy`, no clearing in the `catch` block, and no clearing when the user re-collapses the panel (`expanded = !expanded` at line 86 does not touch `newValue`).
- `apps/web/src/hooks.server.ts` — there **is** a pre-existing, partial mitigation: `redirectIfVaultUnavailable()` calls `getVaultReadiness()` (which hits the allowlisted `GET /ready`) before every protected-app-path request and redirects to `/vault` if not `ready`. This reduces the frequency of the gap but does **not** close it, for two independently-verified reasons this story must handle:
  - **TOCTOU race:** the vault can seal in the (small but real) window between the hook's `/ready` check succeeding and the page's own `PageServerLoad` issuing its rotation/dependency fetch — the load's own fetch still gets a raw `503` in that window, uncaught, which SvelteKit renders as its default (unbranded, unhelpful) error page.
  - **The live poll bypasses the hook entirely:** the rotation detail page's 15-second poll and manual "Refresh" button (`apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/rotations/[rotationId]/+page.svelte`, `refetch()`, lines 47-53) call `getRotation()` via the browser's own `fetch`, which goes straight to the API and **never re-runs `hooks.server.ts`**. Today, `refetch()`'s `catch` block is an empty comment (*"Best-effort — keep showing the last known state if the refetch itself fails"*) — a sealed-vault 503 mid-poll is silently swallowed with **zero** user-visible indication (see AC-5).

Nothing in this story changes any backend file, any role/permission threshold, or any rate-limit value — it only teaches the already-shipped `apps/web/**` UI to handle error responses the backend has always been capable of sending.

---

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `web` |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A — this story only touches already-shipped web UI. |
| **Honest placeholder AC** (if UI deferred) | N/A — no UI is deferred by this story. |
| **Persona journey** | See below. |

### Persona journey stub

**Alex (org admin), mid-incident, using break-glass (the highest-risk path this story hardens):** opens `/rotate` for a leaked key, expands "Emergency: break-glass rotation," pastes the new value, types a reason, types `CONFIRM`. Suppose the vault happens to be sealed at that exact moment (a second admin sealed it moments earlier during the same incident): instead of a generic crash or a silent hang, Alex sees the same "vault is sealed" message already shown elsewhere in the app, with the pasted new value **cleared from the field** rather than sitting there in plaintext while Alex figures out what to do next (AC-16). If Alex instead hits the 10/min break-glass rate limit from a flurry of retries, they see a specific message telling them how many seconds to wait (AC-12) instead of a raw, opaque "Too many authenticated requests" string with no actionable next step.

**Morgan (admin, not yet MFA-enrolled, past their grace period)** tries to initiate a normal rotation. Today, the request 403s with `mfa_required` and Morgan sees nothing (Story 5.4's generic `error.message` fallback shows the raw backend string, no link to fix it). After this story, Morgan sees a specific message with a direct link to `/settings/security` (AC-6), matching the exact working precedent already on the project members page.

**Riley (viewer)** loads a rotation's history/detail page while the vault happens to be sealed. Today this crashes to SvelteKit's default error page. After this story, Riley sees the same friendly, branded "vault sealed" message every other page in this app already uses (AC-1/AC-3), with a link back to the credential.

---

## Epic Cross-Story Context

| Story | Relationship to 8.5 |
|---|---|
| **5.4** (`5-4-rotation-workflow-web-ui.md`, `done`) | **This story's entire subject.** Every file this story touches was created or last modified by 5.4. This story does not re-implement or restructure any of 5.4's 27 ACs — it only adds new error-handling branches and a secrets-clearing fix to the existing pages/components. |
| **5-4-rotation-workflow-web-ui-adversarial-review.md** | Source of findings #1 (critical, sealed-vault scoping), #2 (critical, `mfa_required`), and the 429/secrets-clearing high findings (#3/#4) this story closes. The review's other findings (`confirmedBy`/`RecentAccessEvent` citation error, `initiatedBy` nullability, numeric inconsistency in 5.5's finding count, etc.) are **not** in scope here — Nestor's decision at the retro recheck bundled specifically "the four unresolved adversarial-review findings" (sealed-vault scoping, `mfa_required`, 429, secrets-clearing) into this story, nothing else from that review. |
| 5.1/5.2/5.3 (`done`) | Original source of the 11 rotation endpoints, their role gates, `requireMfa` flags, and rate limits this story's UI must now handle every error branch of. Unchanged by this story — read-only re-verification only. |
| 5.5 (`5-5-epic-5-completion-rotation-hardening-and-technical-debt.md`, `done`) | Separate, already-closed backend hardening story (13 findings). Zero overlap — 5.5 touched `apps/api/**`/`packages/db/**` only; this story touches `apps/web/**` only, same boundary 5.4 itself drew. |
| 8-4 (`8-4-data-subject-erasure-request-handling.md`, `ready-for-dev`) | Sequentially the previous story number in Epic 8, but a **different domain entirely** (GDPR erasure, API-only) with no technical dependency on this story or vice versa. This story's real technical predecessor is 5.4, not 8.4 — noted explicitly so a developer doesn't waste time looking for continuity that doesn't exist between 8.4 and 8.5. |
| `apps/web/src/routes/(app)/projects/[projectId]/members/+page.svelte` | Source of the **working `mfa_required` precedent** this story's ACs require reusing verbatim: `error.code === 'mfa_required'` branch + an inline `{#if errorMessage.includes('MFA')}<a href={resolve('/settings/security')}>Enable MFA</a>{/if}` link. |
| `apps/web/src/lib/components/onboarding/OnboardingStep2.svelte`, `apps/web/src/lib/components/rotations/{BreakGlassPanel,ChecklistItemRow,StaleRecoveryBanner}.svelte`, both `rotate`/`rotations/[rotationId]` `+page.svelte` files | Source of the **existing, working `onboardingCopy.vaultSealedMessage` reuse pattern** for mutation-time 503s — already correctly implemented by 5.4 for every mutation. This story extends the *same* message/pattern to the four **page-load** paths that don't yet have it (AC-1 through AC-4) and to the poll (AC-5); it does not change the mutation-time handling that already works. |

---

## Ground-Truth API Surface (Re-Verified for This Story)

*(No new endpoints. Reproduced from Story 5.4 with re-confirmed `requireMfa`/rate-limit columns added.)*

| Method & path | Min role | `requireMfa` | Rate limit | Relevant error codes this story must handle |
|---|---|---|---|---|
| `POST .../rotations` (initiate) | `admin` | **yes** | 30/min | `403 mfa_required`, `429 rate_limit_exceeded`, `503` (sealed) |
| `GET .../rotations/:id` | `viewer` | n/a (read) | none | `503` (sealed) — **page-load gap** |
| `GET .../rotations` (list/history) | `viewer` | n/a (read) | none | `503` (sealed) — **page-load gap** |
| `GET .../dependencies` | `viewer` | n/a (read) | none | `503` (sealed) — **page-load gap** |
| `GET /api/v1/projects/:projectId/rotations/upcoming` | `viewer` | n/a (read) | none | `503` (sealed) — **page-load gap** |
| `POST .../checklist/:itemId/confirm` | `member` | no | 60/min | `429 rate_limit_exceeded`, `503` |
| `POST .../checklist/:itemId/fail` | `member` | no | 60/min | `429 rate_limit_exceeded`, `503` |
| `POST .../checklist/:itemId/retry` | `member` | no | 60/min | `429 rate_limit_exceeded`, `503` |
| `POST .../complete` | `admin` | **yes** | 60/min | `403 mfa_required`, `429 rate_limit_exceeded`, `503` |
| `POST .../rotations/break-glass` | `admin` | **yes** | **10/min** | `403 mfa_required`, `429 rate_limit_exceeded`, `503` |
| `POST .../resume` | `admin` | **yes** | **30/min** | `403 mfa_required`, `429 rate_limit_exceeded`, `503` |
| `POST .../abandon` | `admin` | **yes** | **30/min** | `403 mfa_required`, `429 rate_limit_exceeded`, `503` |

**Exact 429 response shape** (from `apps/api/src/lib/route-helpers.ts::enforceUserRateLimit`, unchanged by this story):
```json
{ "code": "rate_limit_exceeded", "message": "Too many authenticated requests", "retryAfter": 37 }
```
`retryAfter` is whole seconds until the caller's per-user rate-limit window resets. `apps/web/src/lib/api/client.ts`'s `ApiFailure` type already declares `retryAfter?: number` — read it via `error.body?.retryAfter` (an `ApiClientError` instance's `.body` field, already typed as `ApiFailure | null`). **No new shared-schema or client-type work is needed for this story.**

**Exact 503 response shape** (from `apps/api/src/plugins/vault-guard.ts`, unchanged):
```json
{ "status": "sealed", "message": "Vault not initialized" }
```

**Exact `mfa_required` response shape** (from `apps/api/src/modules/auth/mfa-enforcement.ts`, unchanged):
```json
{ "code": "mfa_required", "message": "MFA enrollment is required for Owner and Admin roles. Enroll at /settings/security." }
```

---

## Design Decisions (Read First)

| # | Decision | Rationale |
|---|---|---|
| D1 | **New page-load data field: `vaultSealed: true`.** Each of the 4 `PageServerLoad` functions this story touches (AC-1 through AC-4) gains logic that, on `ApiClientError` with `status === 503`, returns the page's existing data shape with a new `vaultSealed: true as const` field (all other fields `null`/empty) instead of re-throwing. **This is only an "extend an existing branch" change for 2 of the 4 files**: `credentials/[credentialId]/+page.server.ts` and `rotations/[rotationId]/+page.server.ts` already wrap their loader body in a `try`/`catch` with a `notFound: true as const` 404 branch (confirmed by direct `Read`) — for these two, add a sibling `if (error.status === 503)` branch alongside the existing 404 check. The other 2 — `rotate/+page.server.ts` (no `try`/`catch` at all today; its `load` calls `listRotations`/`listCredentialDependencies` unguarded) and `dashboard/+page.server.ts` (no `notFound`/`vaultSealed`-style discriminant field at all today — it only silently `.catch()`s 404s down to `null`) — require **introducing new try/catch structure from scratch**, not extending an existing flag; see AC-2 and AC-4 for the exact per-file mechanics. The corresponding `+page.svelte` checks `data.vaultSealed` **before** any existing not-found/access condition (a sealed vault preempts a "does this exist" or "can I see this" question — you can't know yet) and renders an inline block, styled identically to the existing `notFound` block, containing `onboardingCopy.vaultSealedMessage` verbatim. Using the *same field name* (`vaultSealed`) across all 4 loaders is deliberate — a developer grepping one file for the pattern immediately finds it in the other three. |
| D2 | **No new `+error.svelte`.** SvelteKit's generic thrown-error path (`error()` helper + a route-level `+error.svelte`) is **not** used here, because (a) no `+error.svelte` exists anywhere in this app today (confirmed: zero files matching that name under `apps/web/src/routes`), and introducing the app's first one is a bigger, riskier surface change than reusing each page's already-existing `notFound`-style inline-block pattern (D1), which every one of the 4 target files already has precedent for. |
| D3 | **Shared error-mapping helper, not 5 copy-pasted `if` chains.** `ChecklistItemRow.svelte` already has a private `handleSealedOrGeneric()` helper (503 → `vaultSealedMessage`, else `error.message`). This story extracts a shared version — `mapRotationMutationError(error, fallback)` — into `apps/web/src/lib/components/rotations/rotation-copy.ts` (the existing shared-copy module for this feature area; do not create a new file), covering **503 → `vaultSealedMessage`**, **403 `mfa_required` → a rotation-action-specific message + the `/settings/security` link cue**, **429 → a message that reads the `retryAfter` seconds**, else `error.message`. All 5 mutation call sites (`rotate/+page.svelte`'s initiate, `BreakGlassPanel.svelte`, `ChecklistItemRow.svelte`'s confirm/fail/retry, the rotation detail `+page.svelte`'s complete, `StaleRecoveryBanner.svelte`'s resume/abandon) call this one helper instead of re-deriving the same three branches independently. This directly follows the jscpd-duplication-avoidance precedent already documented in this codebase's own code comments (e.g. `ChecklistItemRow.svelte`'s `isConcurrentModificationError` helper, extracted for the identical reason). |
| D4 | **`mfa_required` message is action-specific, matching the members-page precedent exactly.** The members page does **not** show the backend's raw message string — it substitutes a short, context-specific one (*"Enable MFA to invite teammates."*) and conditionally renders an `<a href={resolve('/settings/security')}>Enable MFA</a>` link whenever `errorMessage.includes('MFA')`. This story's shared helper (D3) takes an `actionLabel` parameter (e.g. `"start a rotation"`, `"complete this rotation"`, `"perform break-glass rotation"`, `"resume this rotation"`, `"abandon this rotation"`) and produces `"Enable MFA to {actionLabel}."` — every call site renders the same conditional MFA link markup the members page uses, verbatim. |
| D5 | **Break-glass secret-clearing is stricter than the normal-path form's existing on-error behavior — this is an intentional, documented asymmetry, not a bug to reconcile.** Story 5.4's AC-4 (normal-path initiate form) deliberately does **not** clear the new-value field on a `422` error, so the admin doesn't have to re-type/re-paste after a validation failure — that decision is **unchanged by this story** and must not be "fixed" to match break-glass's new behavior. Break-glass is different: it is explicitly the higher-blast-radius, incident-time path the original review called out by name, and the new-value field there gets cleared on **any** terminal outcome (success *or* error) per AC-16, plus on teardown (AC-17) and panel-recollapse (AC-18). If a break-glass submit fails, the admin must re-paste the value — a deliberate, small friction cost this story accepts in exchange for not leaving a live secret sitting in a mounted DOM node indefinitely during an incident. |
| D6 | **Live-poll 503 handling shows a passive banner, not an interrupting modal.** AC-5 fixes the previously-silent `refetch()` catch block to surface `onboardingCopy.vaultSealedMessage` in the same inline-banner slot the page already uses for `concurrentBanner` (AC-15 of Story 5.4) — it does not stop or reset polling (the poll will naturally recover and clear the banner once the vault is unsealed and a subsequent poll succeeds), and it does not block the manual "Refresh" button, which surfaces the identical message on-demand if clicked while sealed. |

---

## Acceptance Criteria

### AC Quick Reference

| Group | ACs | Required result |
|---|---|---|
| A — Sealed vault (503) on page load | AC-1 to AC-5 | Every `PageServerLoad` this story touches, plus the rotation detail page's live poll, shows the existing `onboardingCopy.vaultSealedMessage` instead of crashing or silently doing nothing. |
| B — `mfa_required` (403) on mutations | AC-6 to AC-10 | Every one of the 5 MFA-gated rotation mutations shows a specific, actionable message with a link to `/settings/security`, matching the members-page precedent. |
| C — Rate limit (429) on mutations | AC-11 to AC-15 | Every rotation mutation shows a specific message including the seconds-until-retry, not a raw/generic string. |
| D — Break-glass secrets clearing | AC-16 to AC-19 | The break-glass new-value field never lingers in memory/DOM beyond its immediate use — cleared on error, teardown, and panel re-collapse — without changing the unrelated normal-path form's existing on-error behavior. |
| E — Consistency, non-regression, tests | AC-20 to AC-23 | One shared helper (not 5 duplicated branches), zero backend diff, and full test coverage for every new branch. |

---

### Group A — Sealed Vault (503) on Page Load

#### AC-1: Credential Detail Page Load — Sealed Vault

**Given** the vault is sealed,
**When** any user loads `/projects/:projectId/credentials/:credentialId` (`apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.server.ts`, whose `load` calls `getCredential`, `listCredentialVersions`, and `listRotations` twice — once for the active-rotation check, once for the paginated history),
**Then** any of those calls throwing `ApiClientError` with `status === 503` is caught and the loader returns `{ ...existing shape with nulled fields, vaultSealed: true as const }` (per D1) instead of letting the error propagate, and `+page.svelte`'s existing `{#if data.notFound || !data.credential}` check is changed to check `data.vaultSealed` **first, before** that combined condition (i.e. `{#if data.vaultSealed} ... {:else if data.notFound || !data.credential} ... {:else}`) — this ordering is required, not cosmetic: because `credential` is nulled on a sealed response exactly like on a 404 (per D1), the current unmodified `!data.credential` check would otherwise catch the sealed case too and render "Credential not found," which is wrong. The sealed branch renders an inline block (styled like the existing `notFound` block: red border, `role="alert"`) containing `onboardingCopy.vaultSealedMessage` verbatim, with no "Back to credential" link (there is nowhere more specific to go back to — this is the credential page itself).

**Example (happy path — vault sealed mid-session):** An admin bookmarked this credential page. A teammate seals the vault for maintenance. The admin reloads the tab. Instead of SvelteKit's generic 500 error page, they see: *"The vault is currently sealed. An administrator must unseal it before rotations can be started or updated."* in the same red-alert card style already used elsewhere on this page.

**Edge case — `existing 404 (`notFound`) handling must still work unchanged:** a nonexistent/cross-tenant credential ID with an **unsealed** vault still returns `notFound: true` exactly as before — this AC only adds a new branch, it does not touch the existing 404 branch's logic or test expectations.

**Edge case — partial failure ordering:** because the loader's four calls run via `Promise.all(...)` (existing pattern, unchanged), a 503 from *any* of the four is sufficient to trigger `vaultSealed: true` — the loader does not need to distinguish which specific call failed, since a sealed vault means none of them can succeed.

**Test:** mock `fetch` so `getCredential` rejects with `ApiClientError(503, { status: 'sealed', message: 'Vault not initialized' }, 'Vault not initialized')`; render the page with the loader's returned data; assert `screen.getByRole('alert')` contains the literal `onboardingCopy.vaultSealedMessage` string (import the constant in the test, do not hardcode the string — regression-proofs against future copy changes in one place, matching the existing `dashboard-copy.test.ts` `forbiddenDashboardClaims` convention of asserting against the shared constant, not a duplicated literal).

---

#### AC-2: Initiate (`/rotate`) Page Load — Sealed Vault

**Given** the vault is sealed,
**When** an `admin`/`owner` loads `/projects/:projectId/credentials/:credentialId/rotate` (`.../rotate/+page.server.ts`, whose `load` calls `listRotations(..., { limit: 1 })` for the active-rotation redirect guard, then conditionally `listCredentialDependencies(...)`),
**Then**, unlike AC-1's file, this loader has **no existing `try`/`catch` today** (confirmed by direct `Read`: `listRotations`/`listCredentialDependencies` are called unguarded) — this AC requires wrapping the `admin`/`owner` code path (the two calls after the early-return role check below) in a new `try`/`catch` that, on `ApiClientError` with `status === 503`, returns `{ projectId, credentialId, orgRole, canManage: true as const, dependencies: null, vaultSealed: true as const }` instead of letting the error propagate. `.../rotate/+page.svelte` checks `data.vaultSealed` **before** its existing `!data.canManage || !data.dependencies` check (so a `member`/`viewer` on a sealed vault sees the sealed message, not the `AccessNotice` — a sealed vault is a more fundamental blocker than a role gate) and renders the same inline sealed-vault block, with a "Back to credential" link (this page always has a clear parent to return to, unlike the credential page itself in AC-1).

**Example:** Alex (admin) clicks "Start rotation" from the credential page moments after another admin seals the vault. Alex lands on `/rotate` and sees the sealed message immediately, with a working link back to the credential page — never a blank/broken form.

**Edge case — role check runs first in the current code, but must not block this AC:** the current loader returns early for `member`/`viewer` **before** ever calling `listRotations`/`listCredentialDependencies` (AC-6 of 5.4 — "the page never issues the POST/GET at all in this case"). This AC does not change that early-return ordering for non-managing roles — a `member`/`viewer` who hits `/rotate` while sealed still sees the existing `AccessNotice` (role gate), **not** the sealed message, since their role already prevents them from ever reaching the code path that would call the now-sealed endpoints. The sealed-vault handling in this AC applies specifically to the `admin`/`owner` code path that actually issues those two calls.

**Test:** mock `fetch` so `listRotations` rejects with a `503`; render with an `admin` `orgRole`; assert the sealed message renders and the dependency-preview section does not.

---

#### AC-3: Rotation Detail Page Load — Sealed Vault

**Given** the vault is sealed,
**When** any user loads `/projects/:projectId/credentials/:credentialId/rotations/:rotationId` (`.../rotations/[rotationId]/+page.server.ts`, whose `load` calls `getRotation`),
**Then** a `503` is caught in the existing `try`/`catch` (which today only special-cases `status === 404`) by adding a sibling branch: `if (error instanceof ApiClientError && error.status === 503) return { ...shape, rotation: null, notFound: false as const, vaultSealed: true as const }`; the `+page.svelte` checks `data.vaultSealed` before its existing `data.notFound || !rotation` check and renders the sealed block instead of the "Rotation not found" block — these are different conditions (sealed vs. doesn't-exist) and must show different, accurate messages, not be collapsed into one generic "something's wrong" state.

**Example:** Riley (viewer) has a rotation detail page open, refreshes the tab while the vault is sealed. Sees: *"The vault is currently sealed..."* with a "Back to credential" link (reuse the existing link markup already on this page's not-found block) — not "Rotation not found," which would be actively misleading (the rotation does exist).

**Edge case — the existing 404 branch's `error instanceof ApiClientError` check pattern must be preserved, only extended:** do not replace the `if (error.status === 404) {...}` block; add a second `if (error.status === 503) {...}` branch before the final `throw error` fallthrough, in that order (404 first, since it's the existing behavior; 503 second, as a net-new addition) — this ordering has no functional effect (the two statuses are mutually exclusive on any single response) but keeps the diff minimal and the existing branch's git blame intact.

**Test:** mock `getRotation` to reject with a `503`; assert `data.vaultSealed === true` and `data.notFound === false`; render the component and assert the sealed message (not "Rotation not found") appears.

---

#### AC-4: Dashboard Page Load — Sealed Vault (Upcoming Rotations Widget)

**Given** the vault is sealed,
**When** any user loads `/dashboard` (`apps/web/src/routes/(app)/dashboard/+page.server.ts`, whose `load` calls `listProjects`, `getOrgDashboard`, and `getProjectDashboard` — the last of which is what populates `data.dashboard.upcomingRotations`, the field Story 5.4's AC-23 first rendered),
**Then** a `503` from any of `listProjects`, `getOrgDashboard`, or `getProjectDashboard` is caught and the loader returns `{ projects: { items: [] }, selectedProject: null, dashboard: null, orgDashboard: null, vaultSealed: true as const }`. Implementation note, since these three calls currently have **inconsistent** error-handling (confirmed by direct `Read`: `listProjects(fetch)` sits bare inside the `Promise.all([...])` array with **zero** existing catch of any kind; `getOrgDashboard(...)` already has a `.catch()` that special-cases 404; `getProjectDashboard` already has its own `try`/`catch` that special-cases 404) — do **not** try to add a third, differently-shaped 503 branch to match each call's existing 404-handling style. Instead, wrap the loader's **entire body** (the `Promise.all([...])` plus the subsequent `getProjectDashboard` block) in one outer `try`/`catch` that catches `ApiClientError` with `status === 503` and returns the `vaultSealed: true as const` shape above; leave each call's existing inner 404-handling (`.catch()` / inner `try`/`catch`) untouched, since a 503 that isn't first swallowed by one of those (they don't touch 503 today) will propagate up and be caught by this new outer handler regardless of which of the three calls produced it. `+page.svelte` checks `data.vaultSealed` first and renders the sealed message in place of the entire dashboard body (not just the rotations widget — a sealed vault means none of the dashboard's other data is trustworthy either, so a partial-sealed dashboard would be actively misleading).

**Example:** An admin's browser has `/dashboard` open in a pinned tab from before an incident began. The vault gets sealed as part of incident containment. The admin switches to that tab: instead of a half-rendered dashboard with some sections crashed and others stale, they see one clear, honest sealed-vault message for the whole page.

**Edge case — `listProjects` succeeding but `getProjectDashboard` sealing (partial failure):** treat this identically to a full sealed state (`vaultSealed: true`, discard the already-fetched `projects`/`orgDashboard` data) — do not attempt a "partially degraded" dashboard render; this matches D1's "any one of the calls failing sealed means none of them are reliable" reasoning from AC-1.

**Test:** mock `getProjectDashboard` to reject with `503`; assert the loader's returned `vaultSealed === true`; render and assert neither the project stats `<dl>` nor the "Upcoming rotations" section (nor the pre-existing `DashboardPlaceholderGrid`) renders — only the sealed message.

---

#### AC-5: Rotation Detail Page — Live Poll and Manual Refresh — Sealed Vault Mid-Session

**Given** a rotation detail page is open and actively polling (Story 5.4 D1: 15-second interval while `status` is `in_progress`/`stale_recovery`), or the user clicks "Refresh,"
**When** the vault becomes sealed between page load and a poll/refresh tick, so `getRotation(fetch, ...)` inside `refetch()` (`.../rotations/[rotationId]/+page.svelte`, lines ~47-53) rejects with a `503`,
**Then** the currently-empty `catch { /* best-effort, keep showing last known state */ }` block is replaced with logic that (a) still keeps showing the last known rotation state (do not null it out or blank the page — the poll failing is not the same as the rotation not existing), and (b) sets a new `pollSealedBanner` `$state` boolean to `true`, rendering `onboardingCopy.vaultSealedMessage` in the same inline-banner slot/style already used for `concurrentBanner` (Story 5.4 AC-15), and (c) clears `pollSealedBanner` back to `false` the next time `refetch()` succeeds (vault unsealed again) — polling itself is never paused or stopped by this condition (matches D6: the poll is expected to self-heal once someone unseals the vault).

**Example:** Morgan has a `stale_recovery` rotation open, the 15s poll is running. An admin seals the vault to rotate the master key. Morgan's next poll tick 503s; a banner appears: *"The vault is currently sealed. An administrator must unseal it before rotations can be started or updated."* Ten seconds later, the vault is unsealed; the next poll tick succeeds, the banner disappears automatically, no page reload needed.

**Edge case — manual "Refresh" click while sealed:** identical handling — the same `refetch()` function backs both the poll and the button, so this AC's fix covers both call sites with one change, not two.

**Edge case — this is a stricter fix than a truly generic catch-all, on purpose:** do not swallow *other* non-503 errors from `refetch()` silently either without at least logging — however, changing the non-503 branch's behavior is explicitly **out of scope** here (see "Explicit Out of Scope"); only the 503 case gains new handling. A non-503 `refetch()` failure keeps today's exact behavior (silently keep the last known state, no banner).

**Test:** render the rotation detail page with an `in_progress` rotation; advance fake timers past the 15s poll interval with `getRotation` mocked to reject with `503` on that specific call; assert the sealed banner appears; advance timers again with `getRotation` mocked to resolve; assert the banner disappears.

---

### Group B — `mfa_required` (403) on Mutations

#### AC-6: Initiate Rotation — `mfa_required`

**Given** an `admin`/`owner` whose MFA grace period has expired and who has not enrolled,
**When** they submit the initiate-rotation form and `POST .../rotations` returns `403 { code: 'mfa_required', message: '...' }`,
**Then** `.../rotate/+page.svelte`'s existing `catch (error)` block (which today checks `409`/`422`/`403 → generic "You do not have permission..."`/`503`, in that order) gains a **new branch checked before** the existing generic `403` branch: `if (error.status === 403 && error.code === 'mfa_required')` → sets `errorMessage` to the shared helper's (D3/D4) output for `actionLabel: "start a rotation"` (i.e. *"Enable MFA to start a rotation."*), and the form's existing error-display block gains the members-page-style conditional link: `{#if errorMessage.includes('MFA')}<a href={resolve('/settings/security')}>Enable MFA</a>{/if}`.

**Example:** Morgan (admin, MFA grace period expired 2 days ago) fills out the initiate form, clicks "Start rotation." Sees: *"Enable MFA to start a rotation. [Enable MFA →]"* with a working link to `/settings/security` — not the existing generic *"You do not have permission to start a rotation."*, which would be actively misleading (Morgan **does** have the role; MFA is the actual blocker).

**Edge case — the existing generic `403` branch (role-downgrade mid-session, Story 5.4 AC-6's edge case) must still work for the non-MFA case:** the new `mfa_required` branch is checked via `error.code === 'mfa_required'` **in addition to** `error.status === 403`, so a plain `403` with a different/no code (e.g. `insufficient_role` from an actual role downgrade) still falls through to the existing generic message unchanged.

**Test:** mock `initiateRotation` to reject with `ApiClientError(403, { code: 'mfa_required', message: '...' }, '...')`; assert the rendered message contains "Enable MFA to start a rotation" and a link with `href` resolving to `/settings/security`.

---

#### AC-7: Break-Glass Rotation — `mfa_required`

**Given** the same expired-grace-period admin as AC-6, this time using break-glass,
**When** `POST .../rotations/break-glass` returns `403 mfa_required` after the `CONFIRM` friction gate (Story 5.4 AC-20/AC-21),
**Then** `BreakGlassPanel.svelte`'s `catch` block (which today checks `503 → sealed`, `409 rotation_lock_contention`, `404`, else generic) gains the same `mfa_required` branch as AC-6, using `actionLabel: "perform a break-glass rotation"` (*"Enable MFA to perform a break-glass rotation."*), with the same conditional `/settings/security` link, rendered in the panel's existing `errorMessage` slot (the same one AC-16/AC-17/AC-18 below also use — see D3's single shared helper).

**Example:** Alex, mid-incident, types `CONFIRM`, clicks the confirm button. Gets `403 mfa_required` instead of a successful rotation. Sees the specific message and link immediately — critical during an incident, since a generic/confusing error here could cost minutes Alex doesn't have.

**Edge case — this fires *after* the `CONFIRM` gate, not before:** the `mfa_required` 403 is a server response to the actual `POST`, which only ever happens after the client-side `CONFIRM` text match (Story 5.4 AC-20) — this AC does not add any new client-side pre-check for MFA status (the UI has no cheap way to know MFA status without an extra round trip, which is out of scope; the server remains the sole source of truth exactly as the original story's Security row specifies).

**Test:** same shape as AC-6's test, targeting `BreakGlassPanel.svelte`'s `submitBreakGlass()`.

---

#### AC-8: Complete Rotation — `mfa_required`

**Given** the same expired-grace-period admin,
**When** `POST .../complete` returns `403 mfa_required`,
**Then** the rotation detail page's `submitComplete()` `catch` block (which today checks `422 checklist_incomplete`, `422 acknowledgement_required`, `409 concurrent_modification`, `422 rotation_not_active`, `503`, else generic) gains the `mfa_required` branch with `actionLabel: "complete this rotation"` (*"Enable MFA to complete this rotation."*), rendered in the existing `completeError` slot alongside the (unaffected) `pendingItemNames` list rendering.

**Example:** All checklist items are confirmed; Morgan clicks "Complete rotation" but hasn't enrolled in MFA. Sees the specific message + link instead of a raw/generic error, and — importantly — the button re-enables (via the existing `finally { completing = false }`) so Morgan can retry immediately after enrolling, without a page reload.

**Test:** mock `completeRotation` to reject with `403 mfa_required`; assert the message and link render in `completeError`'s slot.

---

#### AC-9: Resume Rotation — `mfa_required`

**Given** the same expired-grace-period admin, with a `stale_recovery` rotation open,
**When** `POST .../resume` returns `403 mfa_required`,
**Then** `StaleRecoveryBanner.svelte`'s `mapError()` helper (which today checks `503`, `422 rotation_not_stale`, else generic) gains the `mfa_required` branch with `actionLabel: "resume this rotation"`, rendered in the banner's existing `errorMessage` slot.

**Test:** mock `resumeRotation` to reject with `403 mfa_required`; assert the message and link render.

---

#### AC-10: Abandon Rotation — `mfa_required`

**Given** the same expired-grace-period admin, past the "Abandon anyway" confirmation step,
**When** `POST .../abandon` returns `403 mfa_required`,
**Then** the same `mapError()` helper handles it with `actionLabel: "abandon this rotation"`, and — critically — the confirmation panel does **not** silently close on this error (unlike the `rotation_not_stale` branch, which does close it per Story 5.4's existing logic, since that error means the decision is moot); the user stays on the "Abandon anyway / Cancel" step so they can retry immediately after fixing MFA without having to re-trigger the confirmation flow from scratch.

**Edge case — do not conflate this with the existing `rotation_not_stale` branch's panel-closing behavior:** `confirmAbandon()`'s current code closes `confirmingAbandon` specifically in the `rotation_not_stale` case (line ~80 today) because that error means the whole decision is moot — the `mfa_required` case must **not** copy that `confirmingAbandon = false` side effect, since the decision (abandon) is still exactly what the admin wants to do, only their MFA status is blocking it.

**Test:** mock `abandonRotation` to reject with `403 mfa_required`; assert the message and link render **and** the confirmation panel (`confirmingAbandon`) remains open/visible.

---

#### Non-Goal (read before implementing Group B): Confirm/Fail/Retry Never Require MFA

**Given** `confirmChecklistItem`, `failChecklistItem`, and `retryChecklistItem`'s server-side `security` blocks (re-verified above) never set `requireMfa: true` — only `minimumRole: 'member'`,
**Then** this story does **not** add an `mfa_required` branch to `ChecklistItemRow.svelte`'s `confirm()`/`submitFail()`/`retry()` functions. Adding one would be dead code that can never actually trigger (the server can never send this error for these three calls), and dead error-handling branches are exactly the kind of unverified, "looks defensive but is actually untestable" code this story's own re-verification-first approach exists to prevent. If a future backend change ever adds `requireMfa` to these three endpoints, that change must come with its own story/AC — do not speculatively add it here.

---

### Group C — Rate Limit (429) on Mutations

#### AC-11: Initiate Rotation — 429

**Given** an admin has already made 30 initiate-rotation requests in the current 60-second window (the server-enforced cap; re-verify by reading `INITIATE_ROTATION_RATE_LIMIT` in `apps/api/src/modules/rotation/routes.ts`, do not hardcode "30" as a UI-side check),
**When** the 31st `POST .../rotations` returns `429 { code: 'rate_limit_exceeded', message: 'Too many authenticated requests', retryAfter: 12 }`,
**Then** `.../rotate/+page.svelte`'s error handling (via the shared D3 helper) shows: *"Too many rotation attempts. Try again in 12 seconds."* (reading `retryAfter` directly from `error.body?.retryAfter`, falling back to a generic *"Try again shortly."* if `retryAfter` is absent/`undefined` for any reason — never crash on a missing field) — not the raw backend string, and not a number hardcoded in the UI.

**Example:** An automated test script (misconfigured, retrying too aggressively) or a very unlucky sequence of manual clicks trips the cap. The admin sees: *"Too many rotation attempts. Try again in 12 seconds."* — a concrete, actionable countdown, not "Too many authenticated requests" with no indication of when to retry.

**Edge case — `retryAfter: 0` (edge of the window):** still render *"Try again in 0 seconds"* literally rather than special-casing zero to something like "now" — the window resets are approximate to the second and a literal `0` reads fine and avoids introducing a special case with its own untested branch.

**Test:** mock `initiateRotation` to reject with `ApiClientError(429, { code: 'rate_limit_exceeded', message: '...', retryAfter: 12 }, '...')`; assert the rendered message contains "12 seconds."

---

#### AC-12: Break-Glass Rotation — 429 (Highest Risk)

**Given** the break-glass endpoint's much tighter 10/min cap (re-verify `BREAK_GLASS_RATE_LIMIT` — do not hardcode "10" in the UI) — the original review specifically flagged this as the highest-risk unhandled case, since a fumbled `CONFIRM` retry during an incident could plausibly trip it,
**When** `POST .../rotations/break-glass` returns `429`,
**Then** `BreakGlassPanel.svelte` shows the same `retryAfter`-aware message as AC-11 but with break-glass-specific framing: *"Too many break-glass attempts. Try again in {retryAfter} seconds — this limit exists to prevent runaway automated calls, not to block a real incident response."* (the extra clause is deliberate: an admin hitting this mid-incident needs reassurance this isn't a permanent block, distinct from the plain generic message used for the lower-stakes initiate/checklist/complete/resume/abandon cases).

**Example:** Alex fat-fingers the `CONFIRM` text three times in under a minute across two different incident credentials, tripping the shared-per-user 10/min cap. Sees the reassuring, specific message with a concrete countdown — not a dead end.

**Edge case — the `CONFIRM` friction gate (Story 5.4 AC-20) still applies on retry:** hitting 429 does not bypass or reset the `CONFIRM`-text requirement — the admin must still re-type `CONFIRM` after the cooldown, exactly as before this story; this AC only changes what message renders while the 429 cooldown is active, not the friction-gate mechanics themselves.

**Test:** mock `breakGlassRotation` to reject with `429 { retryAfter: 45 }`; assert the break-glass-specific message renders with "45 seconds."

---

#### AC-13: Confirm/Fail/Retry Checklist Mutations — 429

**Given** the shared 60/min cap on all three checklist mutation endpoints (`checklistMutationRateLimit()`),
**When** any of `confirm()`/`submitFail()`/`retry()` in `ChecklistItemRow.svelte` receives a `429`,
**Then** the existing `handleSealedOrGeneric()` helper (renamed/extended per D3 into the shared `mapRotationMutationError`) gains the same `retryAfter`-aware message as AC-11 (generic framing, not break-glass-specific): *"Too many attempts. Try again in {retryAfter} seconds."*, rendered in each function's existing `errorMessage` slot.

**Example:** A member rapidly double/triple-clicks "Confirm" across many checklist rows while impatient during a live rotation, tripping the 60/min cap. Sees the countdown message on whichever row's action tripped it, not a raw backend string.

**Test:** mock each of `confirmChecklistItem`/`failChecklistItem`/`retryChecklistItem` to reject with `429` in turn; assert each surfaces the countdown message via the shared helper (one parameterized test covering all three, not three near-duplicate tests, to keep the test file itself DRY per this story's own D3 principle).

---

#### AC-14: Complete Rotation — 429

**Given** the 60/min cap shared with checklist mutations,
**When** `POST .../complete` returns `429`,
**Then** `submitComplete()`'s `catch` block shows the same generic countdown message as AC-13/AC-11 via the shared helper, in the existing `completeError` slot.

**Test:** mock `completeRotation` to reject with `429 { retryAfter: 8 }`; assert "8 seconds" renders in `completeError`.

---

#### AC-15: Resume/Abandon — 429

**Given** the 30/min cap via `resolutionRateLimit()` (a distinct, tighter bucket from the 60/min `checklistMutationRateLimit()` shared by confirm/fail/retry/complete — do not confuse the two when writing the test's mock or assertions),
**When** either `POST .../resume` or `POST .../abandon` returns `429`,
**Then** `StaleRecoveryBanner.svelte`'s `mapError()` shows the same generic countdown message via the shared helper.

**Test:** mock both `resumeRotation` and `abandonRotation` to reject with `429` in turn; assert both surface the countdown message (one parameterized test for both, matching AC-13's DRY test-file guidance).

---

### Group D — Break-Glass Secrets Clearing

#### AC-16: Clear New-Value Field on Failed Break-Glass Submit

**Given** the break-glass panel's `submitBreakGlass()` currently clears `newValue = ''` **only** inside the success path (verified: no clearing anywhere in the `catch` block today),
**When** `breakGlassRotation(...)` rejects for **any** reason (503/403 mfa_required/429/409 rotation_lock_contention/404/422/network error — every branch of the `catch` block),
**Then** `newValue` is set back to `''` **and** the confirm-gate state (`awaitingConfirmText`, `confirmText`) is reset, in a `finally` block: a single `finally { submitting = false; newValue = ''; awaitingConfirmText = false; confirmText = '' }` replaces the current `finally { submitting = false }` (the existing success-path's explicit `newValue = ''` at line 50 becomes redundant but harmless — leave it in place for clarity at the call site, or remove it now that `finally` always runs; either is acceptable as long as the net behavior is "cleared after every terminal outcome, success or failure"). **Resetting `awaitingConfirmText`/`confirmText` alongside `newValue` is required, not optional:** the new-value `<textarea>` is `disabled={awaitingConfirmText}` (existing markup, unchanged) — if only `newValue` were cleared while `awaitingConfirmText` stayed `true`, the admin would be left staring at an empty-but-disabled textarea with no way to re-paste the value, while the confirm button (`disabled={confirmText !== 'CONFIRM' || submitting}`) would still be enabled from a prior successful `CONFIRM` entry and would immediately resubmit with an empty value if clicked. Resetting both fields returns the form to its initial editable state, consistent with AC-12's edge case (the admin must re-type `CONFIRM` after any cooldown/error, not just after a 429) and with D5's "the admin must re-paste the value to retry" framing.

**Example (the exact gap this AC closes):** Alex pastes a live credential value, types a reason, types `CONFIRM`, submits — the vault happens to be sealed (AC-7/mfa_required, or any other error). Today: the plaintext value remains visible in the `<textarea>` indefinitely while Alex reads the error and decides what to do next. After this fix: the textarea is empty immediately after the failed response renders, and Alex must re-paste the value to retry (an accepted, deliberate friction cost — see D5).

**Edge case — the `reason` field is explicitly NOT cleared by this AC:** `reason` is admin-controlled incident context, not a secret (matches the existing codebase's own characterization of similar fields, e.g. `lastFailureReason`, as "admin-controlled free text" rather than sensitive data) — clearing it on every failed attempt would force Alex to re-type incident context on every retry for no security benefit. Only `newValue` is in scope for clearing.

**Edge case — do not change the normal-path (`rotate/+page.svelte`'s non-break-glass) form's on-error behavior:** re-verify after this change that `.../rotate/+page.svelte`'s `submitForm()` (the plain-initiate path) still does **not** clear its own `newValue` on error — that is Story 5.4's AC-4's deliberate, unchanged behavior (D5). This AC touches only `BreakGlassPanel.svelte`.

**Test:** mock `breakGlassRotation` to reject with any error (e.g. a generic `503`); render the panel, fill `newValue`, advance to the `awaitingConfirmText` step, type `CONFIRM`, submit; assert the `<textarea>`'s value is empty immediately after the error renders (via `@testing-library/svelte`'s `getByLabelText('New value')` or the element's `.value`, not just checking the `$state` variable in isolation — the test must prove the *rendered DOM* no longer holds the value, since that's the actual exposure surface this finding is about); **also assert the textarea is no longer `disabled`** (i.e. the form has fallen back out of the `awaitingConfirmText` step to its initial editable state) so the admin can actually re-paste a value, and assert the "Type CONFIRM" input, if still present in the DOM, is empty.

---

#### AC-17: Clear New-Value Field on Component Teardown

**Given** `BreakGlassPanel.svelte` has no `onDestroy` hook today,
**When** the admin has typed a new value into the (unsubmitted) break-glass form and then navigates away from the page (e.g. clicks "Back to credential," or any other link, before submitting or cancelling),
**Then** an `onDestroy(() => { newValue = ''; reason = '' })` hook (or equivalent Svelte 5 teardown mechanism) runs, clearing both fields from the component's `$state` before the component is destroyed.

**Example:** Alex opens the break-glass panel, pastes a new value, gets pulled into a phone call, clicks away to check something else on the credential's page without submitting or explicitly cancelling. The component unmounts; `newValue` is cleared from memory rather than lingering in a detached-but-still-referenced Svelte component instance until garbage collection happens to reclaim it.

**Edge case — this is a defense-in-depth measure, not a functional behavior change a user can observe:** because Svelte fully re-instantiates `BreakGlassPanel.svelte`'s `$state` on next mount regardless (component state does not persist across unmount/remount in this app — no global store holds it, per Story 5.4's own explicit "no rotation store singleton" anti-pattern rule), a user re-opening `/rotate` after navigating away sees an empty form either way, with or without this fix. The value of this AC is specifically reducing how long the plaintext value is reachable in memory before GC, which is not independently observable via component behavior — **the test for this AC verifies the `onDestroy` hook is registered and invoked**, not a user-visible re-render difference.

**Test:** render `BreakGlassPanel.svelte`, set `newValue` via `fireEvent.input`, unmount the component (`cleanup()` from `@testing-library/svelte`, or explicit component `$destroy()`/unmount call per whatever the existing test suite's teardown convention is — check `ChecklistItemRow.test.ts` or similar for the established unmount-testing pattern in this codebase first, reuse it verbatim); assert the component's internal reference to `newValue` was reset before teardown completed — if the test harness cannot directly observe post-unmount internal state, structure the test to spy on the clearing function/hook being called instead of the post-teardown value.

---

#### AC-18: Clear New-Value Field on Panel Re-Collapse

**Given** the panel's `expanded` `$state` boolean toggles via the header button (`onclick={() => (expanded = !expanded)}`) without unmounting the component,
**When** the admin has typed an unsubmitted new value, then clicks the header again to collapse the panel (`expanded` goes from `true` back to `false`) without submitting,
**Then** `newValue` (and `reason`, and any in-progress `awaitingConfirmText`/`confirmText` state) is cleared at the moment of collapse — the panel returns to its fully-reset initial state, not just visually hidden while still holding the typed value in memory, so that re-expanding it later in the same session starts from a clean slate rather than surfacing a stale plaintext value that's been sitting in a collapsed (but still mounted) component the whole time.

**Example:** Alex expands the panel to see what break-glass looks like, pastes a value out of habit, then thinks better of it and collapses the panel without submitting (deciding to try the normal rotation flow instead). Re-expanding the panel later shows an empty form, not the previously-pasted value.

**Edge case — collapsing mid-`awaitingConfirmText` (the `CONFIRM`-gate step) must also fully reset, not just the value fields:** if the admin is on the "Type CONFIRM to proceed" step and collapses the panel, `awaitingConfirmText` resets to `false` and `confirmText` resets to `''` in addition to `newValue`/`reason` — collapsing is a full reset of the entire unsubmitted form, not a partial one, mirroring the existing `cancelConfirmation()` function's reset scope (reuse that function's logic rather than writing a second, slightly different reset routine — DRY).

**Test:** render the panel, expand it, fill `newValue` and advance to the `awaitingConfirmText` step, then click the header to collapse; assert (by re-expanding and checking the form) that `newValue`, `reason`, and `confirmText` are all back to their initial empty values, and `awaitingConfirmText` is `false`.

---

#### AC-19 (Non-Goal / Regression Guard): Normal-Path Initiate Form's On-Error Retention Is Unchanged

**Given** D5's explicit asymmetry decision,
**When** this story's changes land,
**Then** `.../rotate/+page.svelte`'s plain (non-break-glass) `submitForm()` continues to retain `newValue` on a `422`/other error exactly as Story 5.4's AC-4 specified — **this story adds zero new clearing behavior to that function**. A regression test (extending, not replacing, whatever existing test already covers this path from Story 5.4) asserts `newValue` is still non-empty after a mocked `422` rejection on the plain initiate form, specifically to catch an over-eager implementation that "fixes" both forms identically out of a mistaken sense of consistency with AC-16.

**Test:** if Story 5.4's existing `rotate-page.test.ts`/`rotate-page.server.test.ts` (or equivalent) doesn't already assert this, add one assertion that does; if it already does, this AC is satisfied by confirming that existing test still passes unmodified after this story's changes.

---

### Group E — Consistency, Non-Regression, Tests

#### AC-20: Shared Error-Mapping Helper (No Duplicated Branches)

**Given** Groups A/B/C above each touch 5 different mutation call sites (initiate, break-glass, confirm/fail/retry, complete, resume/abandon) plus 4 page-load sites,
**When** this story is implemented,
**Then** the `503`/`mfa_required`/`429` branches for **mutations** are implemented exactly once, in a single exported function in `apps/web/src/lib/components/rotations/rotation-copy.ts` (extending the existing shared-copy module, per D3 — not a new file, not five independent copies), parameterized by an `actionLabel: string` for the `mfa_required` message (D4) and a `rateLimitFraming?: 'default' | 'break-glass'` parameter for AC-12's break-glass-specific 429 copy; all 5 mutation call sites import and call this one function. The 4 **page-load** sites' `vaultSealed` handling (D1) is a separate, simpler pattern (a data-flag + inline-block render, not an error-mapping function) since it runs server-side in a `load` function, not client-side in a component's `catch` block — do not try to unify these two genuinely different mechanisms into one abstraction.

**Test:** a `rotation-copy.test.ts` addition (extending the existing file if present, per the naming convention already used for `rotation-copy.ts`'s existing helpers like `checklistItemStatusBadgeClass`) directly unit-tests the new shared function's output for every input combination (503, `mfa_required` with various `actionLabel`s, 429 with/without `retryAfter`, 429 with `rateLimitFraming: 'break-glass'`, and a fallback generic-error case) — this is more precise and much cheaper to run than re-deriving the same coverage five times across five component test files, though each component's own test file should still have **at least one** integration-level assertion proving it actually calls the shared helper and renders its output (not just that the helper itself works in isolation).

---

#### AC-21: `mfa_required` Link-Out Pattern Matches the Members-Page Precedent Verbatim

**Given** `apps/web/src/routes/(app)/projects/[projectId]/members/+page.svelte` already implements the exact working pattern (`{#if errorMessage.includes('MFA')}<a href={resolve('/settings/security')}>Enable MFA</a>{/if}`),
**When** any of AC-6 through AC-10's error blocks render an `mfa_required` message,
**Then** the same conditional-link markup pattern is used — checking for the substring `'MFA'` in the rendered message (not a separate boolean flag threaded through every call site) and linking to `resolve('/settings/security')` — so a developer who already knows this precedent from the members page recognizes it immediately in the rotation UI, rather than encountering a second, subtly-different mechanism for the same purpose.

**Test:** for each of AC-6 through AC-10's tests, additionally assert the rendered "Enable MFA" link's `href` resolves to `/settings/security` (can be folded into each of those ACs' own tests rather than five separate new test cases, since the assertion is a one-line addition to each).

---

#### AC-22: No Backend Changes — Route-Audit and Test-Suite Non-Regression

**Given** this story adds zero new Fastify routes, zero new DB migrations, and zero new audit events (identical boundary to Story 5.4's own AC-27),
**When** `pnpm --filter @project-vault/api test route-audit.test.ts` and the full `apps/api` test suite are run after this story's changes land,
**Then** both are **unaffected** — every file this story touches is under `apps/web/src/**`; `apps/api/**` and `packages/db/**` have zero diff. If a code-review or CI run shows any `apps/api` file changed as part of this story's PR, that is a scope violation to flag, not accept — the re-verification performed in "Why this story exists" above was read-only (`grep`/`Read`), and this story's implementation must remain read-only against `apps/api/**` too.

---

#### AC-23: Full Regression Suite Stays Green, New Branches Are Covered

**Given** Story 5.4 shipped with 249 passing `apps/web` tests, `tsc --noEmit` clean, and `eslint .` clean,
**When** this story's changes land,
**Then** the full `apps/web` test suite (not just this story's new/modified files) passes with zero regressions, `tsc --noEmit` and `eslint .` remain clean, and every new branch introduced by AC-1 through AC-20 has at least one corresponding test asserting it (no new `if`/`catch` branch ships without a test exercising it — this mirrors the TDD red-green discipline Story 5.4's own Dev Agent Record documents following, and this story must follow the same discipline, not skip it because the change set is "just error handling").

---

## Explicit Out of Scope

- **Any change to role/permission thresholds, rate-limit values, or `requireMfa` flags** — this story only teaches the UI to handle responses the backend has always been capable of sending; it never proposes loosening or tightening any server-side gate.
- **Adding `mfa_required` handling to confirm/fail/retry** — see the Group B non-goal note; these three endpoints never set `requireMfa` server-side, and adding client-side handling for an error they can never send is untestable dead code.
- **Changing the normal-path (non-break-glass) initiate form's on-error value-retention behavior** — Story 5.4's AC-4 is unchanged; see D5 and AC-19.
- **A generic non-503 error-handling overhaul of `refetch()`'s catch block** — AC-5 only adds a 503-specific branch; the existing silent-catch behavior for all other error types is unchanged.
- **A new `+error.svelte` or app-wide error-boundary mechanism** — see D2; this story reuses each page's existing inline-block pattern instead.
- **Masking/reveal-toggle UI for the break-glass new-value textarea** — the original 5.4 story explicitly scoped the field as plaintext-visible (no `type="password"`-equivalent exists for a `<textarea>`, and no reveal/hide toggle was specified); this story only addresses *how long* the value persists in state/DOM, not *whether* it's visible while present. Adding a masking UI is a separate, larger UX change not requested by the adversarial review or the retro decision.
- **Any of the adversarial review's other (non-bundled) findings** — the `confirmedBy`/`RecentAccessEvent` citation error, `initiatedBy` nullability rendering, the 5.5 finding-count discrepancy, the free-text-escaping guidance, the `member`-Complete-button gap, the dual-active-rotation edge case, and the `noRotationsYet` constant's task-list omission are all **not** in scope — Nestor's retro-recheck decision explicitly bundled only "the four unresolved adversarial-review findings" (sealed-vault scoping, `mfa_required`, 429, secrets-clearing) into this story.
- **Playwright / E2E browser tests** — unchanged repo-wide gap; this story's tests are Vitest + `@testing-library/svelte` only, consistent with every other web story.

---

## Tasks / Subtasks

- [x] **Task 1: Shared error-mapping helper** (AC-20, AC-21, supports AC-6–AC-15)
  - [x] Extend `apps/web/src/lib/components/rotations/rotation-copy.ts` with `mapRotationMutationError(error, { actionLabel, rateLimitFraming? }, fallback)` covering 503/`mfa_required`/429/generic
  - [x] Extend `apps/web/src/lib/components/rotations/rotation-copy.test.ts` with full input-coverage unit tests for the new function

- [x] **Task 2: Page-load sealed-vault handling** (AC-1, AC-2, AC-3, AC-4)
  - [x] `.../credentials/[credentialId]/+page.server.ts` + `+page.svelte` — `vaultSealed` catch branch + inline block
  - [x] `.../rotate/+page.server.ts` + `+page.svelte` — same pattern, checked before the existing `AccessNotice` gate
  - [x] `.../rotations/[rotationId]/+page.server.ts` + `+page.svelte` — same pattern, checked before the existing `notFound` block
  - [x] `apps/web/src/routes/(app)/dashboard/+page.server.ts` + `+page.svelte` — same pattern, whole-page sealed state
  - [x] Corresponding test updates in each route's existing `*.server.test.ts`/page test file

- [x] **Task 3: Live-poll sealed-vault handling** (AC-5)
  - [x] `.../rotations/[rotationId]/+page.svelte`'s `refetch()` — new `pollSealedBanner` state + banner render
  - [x] Fake-timer test covering poll-tick 503 then recovery

- [x] **Task 4: `mfa_required` (403) handling** (AC-6, AC-7, AC-8, AC-9, AC-10, + Group B non-goal note)
  - [x] `.../rotate/+page.svelte` (initiate)
  - [x] `BreakGlassPanel.svelte` (break-glass)
  - [x] `.../rotations/[rotationId]/+page.svelte` (complete)
  - [x] `StaleRecoveryBanner.svelte` (resume, abandon — abandon's confirmation-panel-stays-open nuance from AC-10)
  - [x] Do NOT touch `ChecklistItemRow.svelte`'s confirm/fail/retry (non-goal)
  - [x] Tests for each of the 5 call sites, including the `/settings/security` link assertion (AC-21)

- [x] **Task 5: 429 rate-limit handling** (AC-11, AC-12, AC-13, AC-14, AC-15)
  - [x] `.../rotate/+page.svelte` (initiate — generic framing)
  - [x] `BreakGlassPanel.svelte` (break-glass — break-glass-specific framing, AC-12)
  - [x] `ChecklistItemRow.svelte` (confirm/fail/retry — generic framing, parameterized test)
  - [x] `.../rotations/[rotationId]/+page.svelte` (complete — generic framing)
  - [x] `StaleRecoveryBanner.svelte` (resume/abandon — generic framing, parameterized test)

- [x] **Task 6: Break-glass secrets clearing** (AC-16, AC-17, AC-18, AC-19)
  - [x] `BreakGlassPanel.svelte` — clear `newValue` in `finally` (AC-16)
  - [x] `BreakGlassPanel.svelte` — `onDestroy` clearing `newValue`/`reason` (AC-17)
  - [x] `BreakGlassPanel.svelte` — collapse handler reuses `cancelConfirmation()`-style full reset (AC-18)
  - [x] Regression test confirming `.../rotate/+page.svelte`'s plain form is unchanged (AC-19)

- [x] **Task 7: Non-regression verification** (AC-22, AC-23)
  - [x] Confirm zero `apps/api`/`packages/db` diff before opening the PR
  - [x] Full `apps/web` suite green, `tsc --noEmit` clean, `eslint .` clean
  - [x] Spot-check every new branch has a corresponding test (no untested `if`/`catch` additions)

---

## Dev Notes

### Project Structure Notes

| Area | Guidance |
|---|---|
| Modified files only | This story modifies existing files under `apps/web/src/**` — it creates **no new routes, no new components, no new client-module files**. The only "new" surface is a handful of new exported functions/constants inside the existing `rotation-copy.ts` shared-copy module. |
| No new API client functions | `apps/web/src/lib/api/rotations.ts` needs no changes — every error shape this story handles (`503`, `403 mfa_required`, `429`) is already representable via the existing `ApiClientError`/`ApiFailure` types (`status`, `code`, `body.retryAfter`). Do not add new typed error-body interfaces for these — they're simpler than the `RotationInProgressErrorBody`-style typed bodies used for 409/422 cases, since this story only ever reads `status`, `code`, and `body?.retryAfter`, all already on the base types. |
| No new DB/API files | Confirmed zero migration, zero new `apps/api/src/modules/rotation/**` files, zero new `packages/shared/src/schemas/**` files. |

### Key Code Patterns to Follow

- **Sealed-vault message:** `onboardingCopy.vaultSealedMessage` from `$lib/components/onboarding/onboarding-logic.js` — reused verbatim everywhere in this story, exactly as Story 5.4 already does for mutations. Never invent a new string for the same condition.
- **`mfa_required` link pattern:** copy the members page's `{#if errorMessage.includes('MFA')}<a href={resolve('/settings/security')}>Enable MFA</a>{/if}` markup verbatim (`apps/web/src/routes/(app)/projects/[projectId]/members/+page.svelte`).
- **`vaultSealed` page-data flag (D1):** mirror the existing `notFound: true as const` pattern already used in `credentials/[credentialId]/+page.server.ts` and `rotations/[rotationId]/+page.server.ts` — same shape, same "all other fields nulled" convention, same `as const` typing so `+page.svelte`'s discriminated-union narrowing works cleanly.
- **Shared helper location:** `apps/web/src/lib/components/rotations/rotation-copy.ts` — this file already exports `rotationCopy`, `formatDateTime`, `checklistItemStatusLabel/BadgeClass`, `rotationStatusLabel/BadgeClass`; add the new error-mapping function alongside these, following the same plain-function-export style (no classes, no default export).
- **Testing:** `@testing-library/svelte` (`render`, `screen`, `fireEvent`, `cleanup`) + `vitest` (`describe`/`it`/`expect`/`vi`), `vi.useFakeTimers()` for the AC-5 poll test (check how Story 5.4's own poll-related tests, if any exist for the 15s interval, structured their fake-timer setup — reuse that exact pattern rather than inventing a new one).
- **Rate-limit/MFA/sealed re-verification discipline:** every numeric/shape claim in this story ("30/min," "10/min," "60/min," the exact 429/503/403 JSON shapes) was re-confirmed by direct `Read`/`grep` against the current branch's `apps/api/src/modules/rotation/routes.ts`, `apps/api/src/lib/route-helpers.ts`, `apps/api/src/plugins/vault-guard.ts`, and `apps/api/src/modules/auth/mfa-enforcement.ts` as of 2026-07-06 — if any of these have changed since, treat the live code as authoritative over this document, exactly as Story 5.4's own "Why this story exists" section instructs for its own claims.

### Tech Stack (Repo Pinned, Unchanged by This Story)

| Tech | Version | Notes |
|---|---|---|
| SvelteKit | `^2.68.0` | `PageServerLoad`/`PageServerData` typed via `./$types.js`, unchanged. |
| Svelte | `^5.56.4` | Runes (`$state`, `$derived`, `$props`, `onDestroy`) — no legacy `export let`. |
| Tailwind CSS | `^4.3.1` | Reuse existing card/alert/banner utility classes verbatim — no new visual language introduced. |
| Vitest | `^4.1.9` | Unified test runner; `vi.useFakeTimers()` available for AC-5. |
| @testing-library/svelte | `^5.4.2` | Component tests. |

### Architecture Compliance

- No new backend surface of any kind (AC-22) — this is a pure `apps/web/**` story, identical boundary to 5.4.
- Every mutation call continues through the existing `apiFetch`/`ApiClientError` pattern — no new auth mechanism, no new HTTP client.
- Client-side error-message mapping is a UX concern only; this story adds zero new authorization logic and zero new server-side checks — every error this story handles is one the server already produces today.
- No new environment variables, no new feature flags.

### Anti-Patterns (Do Not)

- Do not add `mfa_required` handling to confirm/fail/retry — see Group B's non-goal note; the server can never send it there.
- Do not hardcode "30," "10," or "60" as UI-side rate-limit numbers anywhere — always read `retryAfter` from the actual error response; the UI never needs to know the configured cap itself, only the seconds-until-retry the server already computed.
- Do not change the normal-path initiate form's on-error value retention (Story 5.4 AC-4) — see D5/AC-19.
- Do not introduce a new `+error.svelte` or global error-boundary mechanism — see D2.
- Do not duplicate the 503/`mfa_required`/429 mapping logic five times across five files — see D3/AC-20.
- Do not clear the break-glass panel's `reason` field on error (only `newValue`) — see AC-16's edge case.
- Do not touch any file under `apps/api/**` or `packages/db/**` — this story's re-verification of backend behavior is read-only, and its implementation must be too.

---

## Previous Story Intelligence

### Story 5.4 (`5-4-rotation-workflow-web-ui.md`, `done`) — the substantive predecessor

Every file this story modifies was created by 5.4. Key learnings carried forward:

- 5.4's Dev Agent Record notes it followed strict TDD red-green per task — this story must do the same; see AC-23.
- 5.4 hit an `eslint` `svelte/prefer-writable-derived` issue on the rotation detail page's `$state`+`$effect` sync pattern, resolved via a writable `$derived(data.rotation)`. This story's `pollSealedBanner` (AC-5) is a plain, independent `$state` boolean, not derived from `rotation`, so this specific lint rule should not resurface — but re-run `eslint .` as part of AC-23 regardless.
- 5.4's own adversarial review (the direct source of this story) is the single most important prior-context document — read it in full before starting, not just this story's excerpts of it.
- 5.4's File List (reproduced in that story's own document) is the authoritative map of every file this story will touch; this story does not introduce any file not already on that list.

### Story 8-4 (`8-4-data-subject-erasure-request-handling.md`, `ready-for-dev`) — sequential-only, no technical relevance

Immediately prior story number in Epic 8's sequence, but a different domain (GDPR erasure, API-only) with zero file or logic overlap with this story. Do not look here for continuity — see Epic Cross-Story Context table above.

---

## References

- [Source: `_bmad-output/implementation-artifacts/5-4-rotation-workflow-web-ui-adversarial-review.md`] — origin of all four bundled findings.
- [Source: `_bmad-output/implementation-artifacts/epic-5-retro-2026-07-05.md`, "Addendum (2026-07-06)"] — the retro recheck and Nestor's decision to bundle these four findings into this story.
- [Source: `_bmad-output/implementation-artifacts/5-4-rotation-workflow-web-ui.md`] — the story whose shipped UI this story hardens; every file/AC-number cross-reference above points here.
- [Source: `_bmad-output/implementation-artifacts/sprint-status.yaml`, `8-5-rotation-web-ui-hardening` entry] — scheduling rationale, reproduced in this story's opening section.
- [Source: `_bmad-output/implementation-artifacts/product-surface-contract.md`] — Product Surface Contract rules (G1-G4) followed above.
- [Source: `apps/api/src/plugins/vault-guard.ts`] — `VAULT_GUARD_ALLOWLIST`, re-verified for this story.
- [Source: `apps/api/src/modules/rotation/routes.ts`] — `requireMfa` flags and rate-limit constants, re-verified for this story.
- [Source: `apps/api/src/lib/route-helpers.ts`] — `enforceUserRateLimit()`, exact 429 response shape.
- [Source: `apps/api/src/modules/auth/mfa-enforcement.ts`] — exact `mfa_required` response shape and message.
- [Source: `apps/web/src/hooks.server.ts`, `apps/web/src/lib/api/vault.ts`] — the existing, partial `redirectIfVaultUnavailable`/`getVaultReadiness` mitigation and why it doesn't fully close the gap (TOCTOU + poll bypass).
- [Source: `apps/web/src/lib/components/onboarding/onboarding-logic.ts`] — `onboardingCopy.vaultSealedMessage`, reused verbatim throughout this story.
- [Source: `apps/web/src/routes/(app)/projects/[projectId]/members/+page.svelte`] — the working `mfa_required` + `/settings/security` link precedent.
- [Source: `apps/web/src/lib/components/rotations/{rotation-copy.ts,rotation-permissions.ts,BreakGlassPanel.svelte,ChecklistItemRow.svelte,StaleRecoveryBanner.svelte}`, `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/{+page.server.ts,+page.svelte,rotate/+page.server.ts,rotate/+page.svelte,rotations/[rotationId]/+page.server.ts,rotations/[rotationId]/+page.svelte}`, `apps/web/src/routes/(app)/dashboard/{+page.server.ts,+page.svelte}`] — every file this story modifies, all created/last-touched by Story 5.4.
- [Source: `apps/web/src/lib/api/client.ts`] — `ApiClientError`/`ApiFailure` types, confirmed to already support every field this story needs (`status`, `code`, `body.retryAfter`).

---

## Dev Agent Record

### Agent Model Used

Claude (Sonnet 4.5), via the `bmad-dev-story` workflow.

### Debug Log References

- TDD red-green followed per task: for each AC group, new/extended `it(...)` cases were written first and run to confirm failure for the expected reason (missing branch/uncaught error/`is not a function`), then the minimal implementation was added and the same scoped test file was re-run to green, before moving to the next task.
- Two `eslint` complexity violations surfaced only after all ACs were implemented (`mapRotationMutationError` and the credential-detail loader's `catch` both exceeded the repo's max-complexity-10 rule) — resolved by extracting `mapRateLimitError()` and `handleCredentialLoadError()`/`emptyCredentialPageResult()` helpers with no behavior change; full suite + `tsc --noEmit` + `eslint .` re-run clean afterward.
- `apps/api`'s `route-audit.test.ts` could not be run standalone in this workspace (pre-existing `@project-vault/shared` package-resolution error under a bare `vitest run` from `apps/api`, unrelated to this story — `apps/api` has zero diff from this story, confirmed via `git status --porcelain`).

### Completion Notes List

- Group A (AC-1–AC-5, sealed vault on page load + live poll): all 4 `PageServerLoad` functions (credential detail, `/rotate`, rotation detail, dashboard) now catch a `503` and return a `vaultSealed: true as const` discriminant (D1); each `+page.svelte` checks `data.vaultSealed` before its existing `notFound`/`canManage` condition. The rotation detail page's `refetch()` (backing both the 15s poll and the manual "Refresh" button) now sets a `pollSealedBanner` state on a 503, clearing it on the next successful poll, without pausing polling or blanking the last known rotation (D6). Non-503 errors keep the pre-existing silent best-effort behavior.
- Group B (AC-6–AC-10, `mfa_required` on mutations): all 5 MFA-gated mutation call sites (initiate, break-glass, complete, resume, abandon) now detect `403 { code: 'mfa_required' }` before falling through to their existing generic-403/other branches, rendering an action-specific "Enable MFA to ..." message plus the members-page's exact `errorMessage.includes('MFA')` → `/settings/security` link markup (AC-21). Confirm/fail/retry deliberately received no such branch (Group B non-goal) — `ChecklistItemRow.svelte` calls the shared helper without an `actionLabel`, so its `mfa_required` branch can never fire there. Abandon's `mfa_required` case does not close the confirmation panel (AC-10), unlike the pre-existing `rotation_not_stale` case.
- Group C (AC-11–AC-15, 429 on mutations): all 5 mutation groups render a `retryAfter`-aware countdown message via the shared helper — generic framing for initiate/checklist/complete/resume/abandon, break-glass-specific reassuring framing for break-glass (AC-12). A missing/non-numeric `retryAfter` falls back to "Try again shortly." rather than crashing or rendering "undefined seconds."
- Group D (AC-16–AC-19, break-glass secrets clearing): `BreakGlassPanel.svelte`'s `submitBreakGlass()` now clears `newValue`/`awaitingConfirmText`/`confirmText` in a single `finally` block covering both success and failure (AC-16); a new `onDestroy` clears `newValue`/`reason` on unmount (AC-17, mirroring the credential detail page's existing `revealedValue` teardown precedent); the header toggle now reuses `cancelConfirmation()`'s reset scope plus clears `newValue`/`reason` on re-collapse (AC-18). The `reason` field is never cleared (admin-controlled incident context, not a secret). The unrelated normal-path initiate form's on-error value retention (Story 5.4 AC-4) is unchanged and covered by its existing regression test (AC-19).
- Group E (AC-20–AC-23): `mapRotationMutationError(error, { actionLabel?, rateLimitFraming? }, fallback)` is the single shared helper in `rotation-copy.ts` covering 503/`mfa_required`/429/generic for all 5 mutation call sites; the 4 page-load sites use the separate, simpler `vaultSealed` data-flag pattern (D1) since they run server-side. Zero `apps/api`/`packages/db` diff (confirmed via `git status --porcelain`). Full `apps/web` suite: 448/448 passing (up from Story 5.4's 249 baseline — the delta reflects all web-story work landed between 5.4 and this story, not just this story's own new tests). `tsc --noEmit` and `eslint .` both clean.
- No ACs were left incomplete. No blockers encountered that required a HALT.

### File List

- `apps/web/src/lib/components/rotations/rotation-copy.ts` (modified — new `mapRotationMutationError`/`mapRateLimitError`/`MapRotationMutationErrorOptions`)
- `apps/web/src/lib/components/rotations/rotation-copy.test.ts` (modified — new `mapRotationMutationError` unit tests)
- `apps/web/src/lib/components/rotations/BreakGlassPanel.svelte` (modified — AC-7/AC-12/AC-16/AC-17/AC-18)
- `apps/web/src/lib/components/rotations/BreakGlassPanel.test.ts` (modified — new tests for the above)
- `apps/web/src/lib/components/rotations/ChecklistItemRow.svelte` (modified — AC-13, `handleSealedOrGeneric` now delegates to the shared helper)
- `apps/web/src/lib/components/rotations/ChecklistItemRow.test.ts` (modified — parameterized AC-13 test)
- `apps/web/src/lib/components/rotations/StaleRecoveryBanner.svelte` (modified — AC-9/AC-10/AC-15)
- `apps/web/src/lib/components/rotations/StaleRecoveryBanner.test.ts` (modified — new tests for the above)
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.server.ts` (modified — AC-1, `vaultSealed` catch branch + complexity-reducing extraction)
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte` (modified — AC-1 sealed-vault render block)
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/credential-detail-page.server.test.ts` (modified — AC-1 loader tests)
- `apps/web/src/routes/projects-credentials.test.ts` (modified — AC-1 render test)
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/rotate/+page.server.ts` (modified — AC-2, new try/catch)
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/rotate/+page.svelte` (modified — AC-2/AC-6/AC-11 render + error handling)
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/rotate/rotate-page.server.test.ts` (modified — AC-2 loader tests)
- `apps/web/src/routes/rotate-page.test.ts` (modified — AC-2/AC-6/AC-11 render tests)
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/rotations/[rotationId]/+page.server.ts` (modified — AC-3 sibling 503 branch)
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/rotations/[rotationId]/+page.svelte` (modified — AC-3/AC-5/AC-8/AC-14)
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/rotations/[rotationId]/rotation-page.server.test.ts` (modified — AC-3 loader tests)
- `apps/web/src/routes/rotation-detail-page.test.ts` (modified — AC-3/AC-5/AC-8/AC-14 render tests)
- `apps/web/src/routes/(app)/dashboard/+page.server.ts` (modified — AC-4, new outer try/catch)
- `apps/web/src/routes/(app)/dashboard/+page.svelte` (modified — AC-4 whole-page sealed render)
- `apps/web/src/routes/(app)/dashboard/dashboard-page.server.test.ts` (new — AC-4 loader tests)
- `apps/web/src/routes/dashboard.test.ts` (modified — AC-4 render test)

### Change Log

- 2026-07-06: Story created via `create-story` from the 2026-07-06 Epic 5 retro-recheck decision to bundle Story 5.4's 4 unresolved adversarial-review findings into a dedicated Epic 8 hardening story. Status: `backlog` → `ready-for-dev`.
- 2026-07-07: Implemented all 23 ACs via `bmad-dev-story` following TDD red-green per task. Zero `apps/api`/`packages/db` diff. Full `apps/web` suite green (448/448), `tsc --noEmit` clean, `eslint .` clean. Status: `ready-for-dev` → `review`.
