# Story 9.8: Platform Admin MFA Gaps and Audit-Bypass Hardening

Status: review

<!-- Hardening/bug-fix story closing two confirmed, currently-unscheduled gaps in already-shipped
     code from Stories 9.4 and 9.7 (both `done`). Not net-new feature work — every AC below is a
     before/after regression fix with its own regression test. Same hardening-bucket pattern as
     8-5/8-6/8-7/9-6. Bundled per `sprint-status.yaml`'s 9-8 entry and
     `deferred-work.md`'s "Deferred from: Epic 9 retrospective (2026-07-08) — Story 9.7" section —
     read both before starting; this story restates everything needed from them so you do not have
     to open them, but they are the traceability source. -->

## Story

As Priya, Project Vault's platform operator (self-hosting the instance; PJ9 in the UX design
spec) — specifically as the realistic first-run case where Priya is the very first user
registered on a fresh instance (auto-flagged `is_platform_operator = true` at registration,
Story 9.1 D1) and has not yet enrolled in MFA —
I want the Platform Admin pages I am required to use before I can even finish onboarding
(`/platform/settings`, `/platform/settings/orgs`, `/platform/settings/resource-usage`,
`/platform/audit`) to tell me clearly that MFA enrollment is what's blocking me and link me
straight to `/settings/security`, instead of a dead-end generic error banner —
and as the platform operator relying on the maintenance-mode audit-bypass during a real storage
outage, I want that bypass to keep queuing entries **only** for genuine storage-unavailability
failures, not to silently swallow an unrelated application bug as if it were one,
so that Story 9.7's own pre-implementation adversarial review findings (Findings 2/3) are actually
reconciled instead of shipping unresolved, and Story 9.4's audit fail-closed guarantee cannot be
defeated by mis-classifying a real defect as a storage outage.

*Closes: `deferred-work.md` § "Deferred from: Epic 9 retrospective (2026-07-08) — Story 9.7"
(TD9-2, and the MFA-page-load-dead-end finding tracked 2026-07-09).*
[Source: `_bmad-output/implementation-artifacts/deferred-work.md#Deferred-from-Epic-9-retrospective-2026-07-08-Story-9.7`]

---

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `both` — Group T (audit-bypass narrowing) is pure `api`; Group M (MFA dead-end fix) is primarily `web` (four `+page.svelte` files) but includes three small, necessary `api` touches: (a) two new backend regression tests for existing-but-untested MFA behavior on `GET /orgs`/`GET /resource-usage` (AC-M6, no code change — these routes already correctly return `403 mfa_required`; only test coverage is missing), and (b) one real backend behavior fix — `GET /platform/maintenance-mode`'s `requireMfa` flag, currently `true`, is a regression from Story 9.7's own documented design intent (`true` (read-only)`) and must revert to `false` (AC-M7), including updating the load-bearing route-audit guard test that would otherwise immediately re-fail. |
| **Evaluator-visible** | yes — every touched page is reachable by any platform operator, including the very first user on a fresh instance. |
| **Linked UI story** (if API-only) | N/A — Group M's UI fix ships in this same story. |
| **Honest placeholder AC** (if UI deferred) | N/A — nothing is deferred further. |
| **Persona journey** | See below. |

### Persona journey stub

**Priya (platform operator, freshly registered, MFA not yet enrolled):** Priya finishes
registering the very first account on a new self-hosted instance and is auto-flagged as the
platform operator. Before touching MFA setup, she clicks **Platform Admin → Settings**. Today
(the bug this story fixes) she sees a plain red box reading "MFA enrollment is required for Owner
and Admin roles. Enroll at /settings/security." with no link — a dead end unless she happens to
retype the URL herself. After this story, the same message renders inside the shared
`MfaAwareErrorAlert` component with a clickable **Enable MFA** link straight to
`/settings/security`. She clicks it, enrolls, returns to **Settings**, and the page now loads
normally. She repeats the same flow on **Organizations**, **Resource Usage**, and
**Platform Audit Log** without needing anyone to tell her what "mfa_required" means. Separately,
during a later real vault-storage outage with maintenance mode active, an unrelated bug causes a
malformed audit payload on one specific action — instead of that bug being silently absorbed into
`platform_audit_pending_entries` as if it were just another queued-because-storage-was-down entry,
it now surfaces immediately as a `503 platform_audit_write_failed` and the triggering action rolls
back, exactly as it would outside a maintenance window — Priya is not misled into thinking the
outage caused it.

**Alex (org admin, NOT a platform operator):** Unaffected by this story — Alex never reaches any
of these pages or routes (`403 platform_operator_required`, unchanged, explicitly re-verified by
AC-M9 as a regression guard).

---

## Background: What Already Exists (Read Before Coding)

This story touches already-shipped, already-tested code from Stories 9.2, 9.4, and 9.7. Treat
everything not explicitly listed as a change target below as a stable dependency — do not
re-implement or "helpfully" extend it.

### Group T — `writePlatformAuditEntryOrFailClosed`'s maintenance-mode bypass

`apps/api/src/lib/audit-or-fail-closed.ts` (196 lines total). The relevant function:

```142:195:apps/api/src/lib/audit-or-fail-closed.ts
export async function writePlatformAuditEntryOrFailClosed(
  tx: Tx,
  input: PlatformAuditInput
): Promise<void> {
  const { request, ...fields } = input
  const resolvedFields: PlatformAuditFields = {
    ...fields,
    ipAddress: fields.ipAddress ?? request?.ip ?? null,
  }

  try {
    await tx.transaction((savepointTx) =>
      writePlatformAuditEntry(savepointTx as Tx, resolvedFields)
    )
  } catch (error) {
    if (await isMaintenanceModeActive(tx)) {
      await queuePendingEntry(tx, {
        ...resolvedFields,
        payload: redactPlatformAuditPayload(resolvedFields.payload, {
          onForbiddenKeyStripped: (message) =>
            process.stderr.write(`[platform-audit] WARN: ${message}\n`),
        }),
      })
      return
    }
    throw new SameTransactionPlatformAuditWriteError(
      error instanceof Error ? error.message : String(error)
    )
  }

  // AC-16: opportunistic drain — never let a drain failure roll back the write that just
  // succeeded above.
  try {
    await drainPendingEntries(tx, resolvedFields.operatorId, { skipLocked: true })
  } catch {
    // Best-effort: the next successful write will retry the drain.
  }
}
```

**The bug (TD9-2):** the `catch` block queues to `platform_audit_pending_entries` on **any**
`error` whenever `isMaintenanceModeActive(tx)` is true — a genuine DB constraint violation, a
forbidden-audit-key caller bug (`redactPlatformAuditPayload` throwing), or any other application
defect gets silently absorbed as if it were a storage outage. This was Story 9.4's own AC-6 text
(`_bmad-output/implementation-artifacts/9-4-platform-operator-audit-log.md#AC-6`) explicitly
listing "DB constraint violation" as a failure this mechanism catches — that original scope is
what this story deliberately narrows. Flagged high-severity in Story 9.4's adversarial review
(`epic-9-retro-2026-07-08.md` Finding 6 / TD9-2 / Action Item A9-6), deferred (not fixed) by Story
9.7 (`9-7-...md` D8/AC-T2), tracked in `deferred-work.md`.
[Source: `_bmad-output/implementation-artifacts/9-4-platform-operator-audit-log.md#AC-6`,
`#AC-15`, `#AC-16`]

**Existing test coverage that must keep passing unchanged (regression baseline):**
`apps/api/src/lib/audit-or-fail-closed.platform-audit.test.ts` — 4 tests: happy-path write,
inactive-maintenance-mode rethrow (`VaultSealedError` via `zeroKeys()`), active-maintenance-mode
queue (same `VaultSealedError`), and opportunistic drain-on-next-success. Uses a real DB + real
vault via `zeroKeys()`/`loadInitialVaultState()`/`unsealVault()` from
`apps/api/src/modules/vault/key-service.ts`, and `activateMaintenanceMode` from
`apps/api/src/modules/platform-audit/maintenance-mode.ts`. `VaultSealedError` (`class
VaultSealedError extends Error {}`) is exported from `key-service.ts`.

### Group M — MFA-unenrolled platform operator page-load dead ends

**Backend (unchanged by this story, confirmed correct):** `settings-routes.ts`, `orgs-routes.ts`,
`resource-usage-routes.ts` (all in `apps/api/src/modules/platform-admin/`) all set
`requireMfa: true` on **every** route (`GET` and mutating alike) — this is a deliberate,
load-bearing convention enforced by an existing regression guard,
`apps/api/src/modules/platform-admin/platform-admin-route-audit.test.ts`, which asserts via a
TypeScript-AST scan that **every** `secureRoute()` call in that module's route files contains
literal `requireMfa: true`. **Do not touch this guard or these three files' `GET` security
blocks** — the backend behavior here is correct and intentional; only the frontend's handling of
the resulting `403 mfa_required` is the bug.

`apps/api/src/modules/platform-audit/routes.ts` similarly sets `requireMfa: true` on `GET
/audit/events`, `GET /audit/verify`, `POST /maintenance-mode`, **and** `GET /maintenance-mode` —
enforced by a sibling guard, `apps/api/src/modules/platform-audit/platform-audit-route-audit.test.ts`.
`GET /maintenance-mode`'s `requireMfa: true` **is** a bug (see AC-M7) — everything else in this
module is correct and must stay untouched.

**Frontend (the actual bug, four page-load paths):**

| Page | `+page.server.ts` error field | `+page.svelte` rendering today | Confirmed defect? |
|---|---|---|---|
| `/platform/settings` | `data.errorMessage` | plain `<p role="alert">` (lines 136-142) | **Yes** — same pattern flagged by 9.7's adversarial review Finding 2 |
| `/platform/settings/orgs` | `data.errorMessage` → local `pageError` state | plain `<p role="alert">` (lines 85-91) | **Yes** — same pattern flagged by 9.7's adversarial review Finding 3 |
| `/platform/settings/resource-usage` | `data.errorMessage` | plain `<p role="alert">` (lines 52-58) | **Yes** — independently re-verified for this story; `MfaAwareErrorAlert` is not even imported into this file today |
| `/platform/audit` | `data.eventsErrorMessage` | plain `<p role="alert">` (lines 246-252) | **Yes** — independently re-verified for this story; contrast with the SAME file's `maintenanceMfaError` state (line 396), which already correctly uses `MfaAwareErrorAlert` — that pattern exists two hundred lines below the bug in the very same file |

All four pages already import (settings/orgs/audit) or need to newly import (resource-usage) the
shared `MfaAwareErrorAlert` component:

```1:29:apps/web/src/lib/components/MfaAwareErrorAlert.svelte
<script lang="ts">
  import { resolve } from '$app/paths'

  let {
    message,
    class: className,
  }: {
    message: string | null
    class: string
  } = $props()
</script>

{#if message}
  <p class={className} role="alert">
    {message}
    {#if message.includes('MFA')}
      <a class="ml-1 underline" href={resolve('/settings/security')}>Enable MFA</a>
    {/if}
  </p>
{/if}
```

It renders nothing when `message` is falsy, and only appends the "Enable MFA" link when the
message text contains the substring `"MFA"` — the backend's `mfa_required` error message already
does (`MFA_REQUIRED_MESSAGE = 'MFA enrollment is required for Owner and Admin roles. Enroll at
/settings/security.'`, `apps/api/src/modules/auth/mfa-enforcement.ts`). **This means no change is
needed in any `+page.server.ts` file** — they already pass the raw `err.message` through
untouched; only the four `+page.svelte` files need their plain `<p>` replaced with
`<MfaAwareErrorAlert>`.

**A fifth, related dead end this story does NOT need to fix, so it isn't missed accidentally:**
`/platform/audit`'s `maintenanceStatusError` (a *second*, separate error state on the same page,
driven by `GET /maintenance-mode`) is currently a **hardcoded generic string** —
`extractMaintenanceData()` in `+page.server.ts` always returns `'Maintenance mode status
unavailable'` regardless of the real cause, never even checking `err instanceof ApiClientError`.
AC-M7 fixes `GET /maintenance-mode`'s `requireMfa` flag so this error path is no longer reachable
*for the MFA reason* at all — an unenrolled operator will simply see real maintenance-mode data
load successfully. Making `extractMaintenanceData()` itself MFA-aware (for some *other*, currently
non-existent failure mode) is out of scope — do not add it; it would be speculative scope beyond
this story's two confirmed defects.

**Story 9.7's own contradiction, for context on why this slipped through
(`9-7-epic-9-completion-platform-operations-web-ui-adversarial-review.md`, Findings 2/3):**

```910:927:_bmad-output/implementation-artifacts/9-7-epic-9-completion-platform-operations-web-ui.md
**AC-G4 — MFA-gated mutation: an un-enrolled operator attempting to save settings sees the
existing MFA-required UX, not a raw 403.**
**Given** `PUT /admin/settings` has `requireMfa: true` and the platform operator has not completed
...
blocked. Do not gate the entire page behind MFA when only the mutation requires it.
```

AC-G4's prose assumed only the *mutation* (`PUT`) required MFA — but `GET /admin/settings` has
always required MFA too (Story 9.2's original, deliberate, guard-enforced design). The review
flagged this contradiction as critical/high before implementation; it was never reconciled. This
story is that reconciliation: not by loosening the backend (which is correct and guarded), but by
making the page's `GET`-load path give the same clear MFA guidance the mutation path already does.

---

## Acceptance Criteria

### Group T — Narrow the maintenance-mode audit-bypass to storage-unavailability errors only

**AC-T1 — New classifier `isPlatformAuditStorageUnavailableError(error)` correctly distinguishes
storage-unavailability failures from application bugs.**
**Given** an error value of unknown shape,
**When** `isPlatformAuditStorageUnavailableError(error)` is called,
**Then** it returns `true` for: (a) any `VaultSealedError` instance; (b) any error whose
`.cause.code` (or own `.code`, matching this codebase's existing `Object.assign(new Error(...), {
cause })` wrapping convention, see `packages/db/src/test-helpers.cleanup-errors.test.ts`'s
`makeQueryError`) is a Postgres SQLSTATE starting with class `08` (Connection Exception) or class
`53` (Insufficient Resources), or is exactly `57P01`/`57P02`/`57P03` (admin shutdown / crash
shutdown / cannot connect now); (c) any error whose `.cause.code` (or own `.code`) is one of the
Node.js socket-level codes `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EHOSTUNREACH`,
`EPIPE` (defense-in-depth for a raw driver-level failure that never got wrapped into a Postgres
error object). It returns `false` for everything else, including a plain `new Error('boom')` with
no `.code` at all.

**Example (positive):** `isPlatformAuditStorageUnavailableError(new VaultSealedError('sealed'))`
→ `true`.

**Example (positive):** `isPlatformAuditStorageUnavailableError(Object.assign(new Error('q'), {
cause: Object.assign(new Error('c'), { code: '08006' }) }))` → `true` (connection failure).

**Example (positive):** `isPlatformAuditStorageUnavailableError(Object.assign(new Error('q'), {
cause: Object.assign(new Error('c'), { code: '53100' }) }))` → `true` (disk full).

**Example (edge — unrelated SQLSTATE class):** `isPlatformAuditStorageUnavailableError(Object.assign(new
Error('q'), { cause: Object.assign(new Error('c'), { code: '23503' }) }))` → `false` (`23503` is
class `23`, Integrity Constraint Violation — a real bug, not storage).

**Example (edge — no `.code` at all, e.g. the forbidden-audit-key assertion error):**
`isPlatformAuditStorageUnavailableError(new Error('payload contains a forbidden audit key'))` →
`false`.

**Example (edge — `.code` present but on the error itself, not nested under `.cause`):**
`isPlatformAuditStorageUnavailableError(Object.assign(new Error('q'), { code: 'ECONNREFUSED' }))`
→ `true`.

Implement in `apps/api/src/lib/audit-or-fail-closed.ts`, exported for direct unit testing.

---

**AC-T2 — Regression: `VaultSealedError` during active maintenance mode still queues (Story 9.4
AC-15, unchanged behavior).**
**Given** the existing test `'queues to platform_audit_pending_entries and resolves when
maintenance mode is active'` in `audit-or-fail-closed.platform-audit.test.ts` (activates
maintenance mode, then `zeroKeys()` to force `VaultSealedError`),
**When** this story's classifier-gated catch clause replaces the current unconditional one,
**Then** this exact existing test must still pass unmodified — `VaultSealedError` is classified
`true` by AC-T1, so the behavior is identical to today.

**Example (regression, must not change):** same as the existing test — one `writePlatformAuditEntryOrFailClosed`
call resolves (does not throw) and exactly one row lands in `platform_audit_pending_entries`.

---

**AC-T3 — New: a genuine storage-unavailability Postgres error during active maintenance mode is
still queued (not just `VaultSealedError`).**
**Given** maintenance mode is active and `writePlatformAuditEntry`'s underlying write throws an
error whose `.cause.code` is `'08006'` (connection failure) — simulated via `vi.mock` on
`../modules/platform-audit/write-entry.js` in a new, DB-free unit test (mirroring
`packages/db/src/test-helpers.cleanup-errors.test.ts`'s mocking style; this specific SQLSTATE
cannot be triggered against a real local Postgres without actually severing the connection),
**When** `writePlatformAuditEntryOrFailClosed` is called,
**Then** it resolves (does not throw) and `queuePendingEntry` is called exactly once with the
(redacted) payload — same outcome as AC-T2, proving the fix generalizes beyond the one
already-tested error type.

**Example (positive):** mocked `writePlatformAuditEntry` throws `Object.assign(new Error('q'), {
cause: Object.assign(new Error('c'), { code: '08006' }) })` → `writePlatformAuditEntryOrFailClosed`
resolves, `queuePendingEntry` called once.

**Example (edge — mocked error has no `.cause`, just a top-level `.code`):** same expectation,
proving the classifier checks both shapes (AC-T1).

---

**AC-T4 — New (the core bug fix): a genuine DB constraint violation during active maintenance mode
now propagates instead of being silently queued.**
**Given** maintenance mode is active and the write attempt fails with a real foreign-key violation
(SQLSTATE `23503`) — triggered by passing an `operatorId` that does not exist in `users` (the
`platform_audit_events.operator_id` column is `notNull().references(() => users.id)`,
`packages/db/src/schema/platform-audit-events.ts`), a real, no-mocking-needed way to force a
genuine constraint violation against the real test DB, matching this file's own existing
`tryDeleteTestUser`'s FK-violation-detection convention (`code === '23503'`),
**When** `writePlatformAuditEntryOrFailClosed` is called with that bad `operatorId`,
**Then** it **rejects** with `SameTransactionPlatformAuditWriteError` — **not** resolved, **not**
queued — and `platform_audit_pending_entries` gains **zero** new rows. This is the exact behavior
change TD9-2 exists for: before this story, this exact scenario silently queued a fake "storage
outage" entry instead of surfacing the bug.

**Example (positive — the regression this story fixes):** `writePlatformAuditEntryOrFailClosed(tx,
{ operatorId: randomUUID() /* nonexistent user */, actionType: 'settings.updated', payload: {} })`
while maintenance mode is active → today: resolves silently, 1 pending row. After this story:
rejects with `SameTransactionPlatformAuditWriteError`, 0 pending rows.

**Example (edge — same scenario, maintenance mode inactive):** identical rejection — this is
already AC-T6's unchanged baseline, included here only to show the two code paths converge on the
same outcome for a genuine bug regardless of maintenance-mode state.

---

**AC-T5 — New: a forbidden-audit-key assertion during active maintenance mode propagates in
dev/test, while Story 9.4's established production strip-and-continue policy remains unchanged.**
**Given** maintenance mode is active and a caller passes a `payload` containing a forbidden key
(e.g. `{ password: 'x' }`, checked via `FORBIDDEN_AUDIT_KEYS`/`isForbiddenAuditKey` from
`apps/api/src/lib/secure-route.ts`, reused by `redactPlatformAuditPayload` in
`apps/api/src/modules/platform-audit/write-entry.ts`),
**When** `writePlatformAuditEntry`'s internal `redactPlatformAuditPayload(fields.payload, ...)`
call throws its non-production assertion error (`'writePlatformAuditEntry: payload contains a
forbidden audit key...'`, a plain `Error` with no `.code`),
**Then** `isPlatformAuditStorageUnavailableError` classifies it `false` (AC-T1's "no `.code`" edge
case) and it propagates as `SameTransactionPlatformAuditWriteError`; the active-maintenance queue
branch is not entered.

**Reconciled contract decision (Nestor, 2026-07-10):** preserve Story 9.4's established production
behavior. In `NODE_ENV=production`, `redactPlatformAuditPayload` strips forbidden keys, emits its
warning, and allows the clean audit row to be written; because no write error occurs, the storage
classifier and maintenance-mode bypass are not involved. Story 9.8 must not change that policy.
The existing production-branch regression test in `platform-audit/write-entry.test.ts` remains the
load-bearing proof.

**Example (positive — test/dev, behavior already effectively "propagates" but via an unwrapped raw
`Error`, not the expected `SameTransactionPlatformAuditWriteError`):** verify the rejected error is
now specifically `instanceof SameTransactionPlatformAuditWriteError`, not a bare `Error` —
tightening the contract, not just preserving the accidental prior behavior.

**Example (production regression):** production payload `{ safeField: 'ok', password: 'secret' }`
is sanitized to `{ safeField: 'ok' }`, logs one warning, and continues without queuing.

---

**AC-T6 — Regression: maintenance mode inactive — any write failure (storage or application bug)
still rethrows unchanged (Story 9.4 AC-6, untouched).**
**Given** the existing test `'rethrows SameTransactionPlatformAuditWriteError when the write fails
and maintenance mode is inactive'` (forces `VaultSealedError` via `zeroKeys()`, maintenance mode
NOT active),
**When** this story's classifier-gated catch clause runs,
**Then** this exact existing test must still pass unmodified — the classifier is irrelevant when
maintenance mode is inactive; every error rethrows regardless of classification.

**Example (regression, must not change):** same as the existing test — the call rejects with
`SameTransactionPlatformAuditWriteError`, zero rows in `platform_audit_pending_entries`.

---

**AC-T7 — Regression: AC-16 opportunistic drain-on-next-success is unaffected by the narrower
classification.**
**Given** the existing test `'drains queued pending entries on the next successful write'`
(queues one entry while sealed + maintenance-mode-active, then unseals and writes again, expecting
a full FIFO drain),
**When** this story's change lands,
**Then** this exact existing test must still pass unmodified — the drain path (`drainPendingEntries`,
called after a successful write, outside the `catch` block entirely) is not touched by this story
at all.

**Example (regression, must not change):** same as the existing test — after the second write, 0
pending rows remain and `platform_audit_events` contains exactly
`['maintenance_mode.deactivated', 'org.created', 'settings.updated']` for that operator.

---

### Group M — MFA-unenrolled platform operator no longer hits a page-load dead end

**AC-M1 — `/platform/settings`: an MFA-required load error renders `MfaAwareErrorAlert` with the
"Enable MFA" link, not a plain banner.**
**Given** an MFA-unenrolled platform operator (grace period expired, per Story 1.7's enforcement
window) navigates to `/platform/settings`,
**When** the page's `load` function's `GET /api/v1/admin/settings` call rejects with `403
{code:'mfa_required', message:'MFA enrollment is required for Owner and Admin roles. Enroll at
/settings/security.'}`,
**Then** `+page.svelte` renders that message via `<MfaAwareErrorAlert message={data.errorMessage}
class="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" />` (same
classes as today's plain `<p>`, replacing lines 136-142), which additionally renders a clickable
"Enable MFA" link to `/settings/security` — the message text itself is unchanged (`+page.server.ts`
is not modified; `data.errorMessage` already carries the raw `err.message`).

**Example (positive):** component test renders the settings page with
`data.errorMessage = 'MFA enrollment is required for Owner and Admin roles. Enroll at
/settings/security.'` → the message text is visible AND `screen.getByRole('link', { name: /enable
mfa/i })` resolves to an `<a>` with `href` matching `/settings/security`.

**Example (edge — settings load successfully, no error at all):** `data.errorMessage` is `null` →
no alert renders at all (the `{:else if settings}` branch, unchanged), matching current behavior
exactly.

---

**AC-M2 — `/platform/settings/orgs`: same fix.**
**Given** the same MFA-unenrolled scenario against `GET /api/v1/admin/orgs`,
**When** the page loads,
**Then** the local `pageError` state (currently rendered via a plain `<p role="alert">` at lines
85-91) is instead rendered via `<MfaAwareErrorAlert message={pageError} class="mt-4 rounded-lg
border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" />`, with the same "Enable MFA"
link behavior as AC-M1. Note: `orgs/+page.svelte` derives `pageError` from `data.errorMessage` into
local `$state` (line 13) rather than reading `data.errorMessage` directly in the template — pass
`pageError`, not `data.errorMessage`, to `MfaAwareErrorAlert`.

**Example (positive):** same shape as AC-M1's positive example, against the orgs page.

**Example (edge — `orgs.length === 0 && !pageError`):** the existing "No organizations found."
empty-state message (line 95's `{#if orgs.length === 0 && !pageError}` guard) must still be
suppressed whenever `pageError` is truthy — unchanged, since the guard condition itself is not
touched by this AC, only the rendering of `pageError` itself changes.

---

**AC-M3 — `/platform/settings/resource-usage`: same fix (independently re-verified defect, see
"What was independently found" note below).**
**Given** the same MFA-unenrolled scenario against `GET /api/v1/admin/resource-usage`,
**When** the page loads,
**Then** the plain `<p role="alert">` at lines 52-58 is replaced with `<MfaAwareErrorAlert
message={data.errorMessage} class="mt-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3
text-sm text-red-800" />`. **This file does not currently import `MfaAwareErrorAlert` at all** —
add `import MfaAwareErrorAlert from '$lib/components/MfaAwareErrorAlert.svelte'` alongside the
existing imports.

**Example (positive):** same shape as AC-M1's positive example, against the resource-usage page.

**Example (edge — warnings banner present alongside the error):** `PlatformWarningsBanner` (line
50, rendered unconditionally above the error/data branch) continues to render independently of
`data.errorMessage`'s state — unchanged, since it is a sibling element, not part of the `{#if
data.errorMessage}` branch.

---

**AC-M4 — `/platform/audit`: the events-list load error gets the same fix (independently
re-verified defect).**
**Given** the same MFA-unenrolled scenario against `GET /api/v1/platform/audit/events` (the
`eventsResult` half of the page's `Promise.allSettled` load, `+page.server.ts` lines 70-76),
**When** the page loads,
**Then** the plain `<p role="alert">` at lines 246-252 (bound to `data.eventsErrorMessage`) is
replaced with `<MfaAwareErrorAlert message={data.eventsErrorMessage} class="mt-4 rounded-xl border
border-red-200 bg-red-50 p-3 text-sm text-red-800" />`. `MfaAwareErrorAlert` is already imported in
this file (used for `maintenanceMfaError` at line 396) — reuse the same import, do not add a
second one.

**Example (positive):** same shape as AC-M1's positive example, against the audit-events section of
the page; the filter form and pagination controls above it remain visible and functional
regardless (they are not gated by `eventsErrorMessage`).

**Example (edge — `eventsErrorMessage` is `null` but `data.events.length === 0`):** the existing
"No platform audit events yet." / "No platform audit events match these filters." empty-state
copy (lines 255-259) is unaffected — that branch is only reached in the `{:else}` of the
`eventsErrorMessage` check, unchanged.

---

**AC-M5 — Regression: a non-MFA load error on all four pages still renders via
`MfaAwareErrorAlert`, but without the "Enable MFA" link.**
**Given** any load-time error whose message does NOT contain the substring `"MFA"` (e.g. a `503`
"Service temporarily unavailable" or a generic network failure caught by each page's existing
`err instanceof ApiClientError ? (err.message ?? 'Failed to load ...') : 'Failed to load ...'`
fallback),
**When** any of the four pages renders that error via `MfaAwareErrorAlert` (post-fix),
**Then** the message text still displays in the same red alert box as before — `MfaAwareErrorAlert`
renders unconditionally on any truthy `message` — but the "Enable MFA" link does NOT appear
(`MfaAwareErrorAlert`'s own `{#if message.includes('MFA')}` guard, untouched by this story).

**Example (positive — unrelated failure, e.g. network error):** `data.errorMessage = 'Failed to
load settings'` → red alert box shows "Failed to load settings", no "Enable MFA" link — visually
almost identical to today's plain `<p>`, just wrapped in the shared component.

**Example (edge — message happens to contain "MFA" for an unrelated reason, e.g. a hypothetical
future error string mentioning MFA in a non-actionable context):** the link still appears — this
is `MfaAwareErrorAlert`'s existing, pre-established, string-match behavior (already used
identically for `saveMfaError`/`createMfaError`/`maintenanceMfaError` elsewhere in these same
files) and is explicitly out of scope to change in this story.

---

**AC-M6 — Backend test-coverage gap closure: add the missing `403 mfa_required` integration tests
for `GET /orgs` and `GET /resource-usage`.**
**Given** `settings-routes.test.ts` and `platform-audit/routes.test.ts` already have a `403
mfa_required for a platform operator who never enrolled MFA` test (confirming the backend behavior
AC-M1/AC-M4 depend on), but `orgs-routes.test.ts` and `resource-usage-routes.test.ts` have **zero**
MFA-related assertions today (confirmed by direct grep — no matches for `mfa` in either file),
**When** this story adds one new test per file, mirroring `settings-routes.test.ts`'s exact
pattern (`registerAndLoginViaApi` → flip `isPlatformOperator` on the DB row directly → expire
`orgMemberships.gracePeriodExpiresAt` to bypass Story 1.7's grace period → call the route),
**Then** `GET /admin/orgs` and `GET /admin/resource-usage` both return `403 {code:'mfa_required'}`
for that unenrolled operator — proving the backend contract AC-M2/AC-M3's frontend fix relies on
was never actually verified by a test until now.

**Example (positive — orgs):** unenrolled platform operator calls `GET /api/v1/admin/orgs` → `403
{code:'mfa_required', message:'MFA enrollment is required for Owner and Admin roles. Enroll at
/settings/security.'}`.

**Example (positive — resource-usage):** same, against `GET /api/v1/admin/resource-usage`.

**Example (edge — same operator, MFA now enrolled):** re-run either test after enrolling MFA (or
simply use the existing `registerPlatformOperator` helper, which enrolls by default) → `200`,
matching each file's existing happy-path tests, proving the new test isn't accidentally always-403.

---

**AC-M7 — Regression fix: `GET /platform/maintenance-mode`'s `requireMfa` flag reverts from `true`
to `false`, matching Story 9.7's own documented design intent — including updating the guard test
that would otherwise immediately re-fail.**
**Given** Story 9.7's endpoint inventory explicitly documented `GET /maintenance-mode` (D2.4) as
`requireMfa: no (read-only)` —

```128:128:_bmad-output/implementation-artifacts/9-7-epic-9-completion-platform-operations-web-ui.md
| `GET /maintenance-mode` (**new**, D2.4) | `/api/v1/platform/maintenance-mode` | `platformAuditRoutes`, `/api/v1/platform` | `{data:{...}}` | platform operator | no (read-only) | new, this story | M |
```

but the shipped code sets `requireMfa: true` (`apps/api/src/modules/platform-audit/routes.ts`,
currently line 346) — confirmed via `git log`/`git show` to be an unintended side effect: commit
`894e286` (Story 9.7's implementation) shipped the route with `requireMfa: false` matching its own
design table, but this immediately violated the **pre-existing** (Story 9.4) load-bearing guard
test `platform-audit-route-audit.test.ts`, which blanket-asserts every `secureRoute()` call in
`platform-audit/routes.ts` has literal `requireMfa: true` with zero exceptions — that guard test
predates `GET /maintenance-mode`'s existence (it was written in Story 9.4, before this route
existed) and was never updated for the new route's intentionally-different requirement. The very
next commit, `f542c9f` ("fix CI failures for 9-7"), flipped the flag to `true` to satisfy the
guard — touching only `routes.ts` (and an unrelated `route-exemptions.ts` entry), **not** the
guard test itself — silently overriding the documented design intent instead of reconciling it,
**When** this story fixes it correctly (not by re-introducing the same CI failure),
**Then** two changes land together: (1) `routes.ts`'s `GET /maintenance-mode` security block
changes `requireMfa: true` → `requireMfa: false`; (2) `platform-audit-route-audit.test.ts`'s
blanket assertion gains a narrow, explicit, named exception for exactly this one route (method
`GET`, url `/maintenance-mode`) — asserting it specifically has `requireMfa: false` (not just
"exempt from requiring true") so a future accidental removal of the security key entirely is still
caught. Every other route in the file keeps the unconditional `requireMfa: true` requirement
unchanged.

**Example (positive):** an MFA-unenrolled platform operator calls `GET
/api/v1/platform/maintenance-mode` → `200 {data:{active:false, pendingEntriesCount:0, ...}}` (new
test; the existing `'D2.4: GET /platform/maintenance-mode returns current status for a platform
operator'` test uses `registerPlatformOperator`, which enrolls MFA by default, so it does not
already cover this case).

**Example (regression, must not change):** the existing `'D2.4/AC-A4: GET /platform/maintenance-mode
returns 403 for non-platform-operator'` test (using `enrollUserWithMfa` for an MFA-enrolled
non-operator, isolating the `platform_operator_required` reason) must still pass unmodified — this
AC only removes the MFA gate, not the platform-operator gate.

**Example (edge — the guard test itself, proving the exception is narrow):** add a unit test (or
extend the existing guard test file) asserting that `POST /maintenance-mode`, `GET /audit/events`,
and `GET /audit/verify` in the same file still fail the guard if their `requireMfa: true` were
hypothetically removed — i.e. the exception list contains exactly one entry, not a loosened regex
that would silently exempt other routes too.

**Also fix while touching this code (documentation accuracy, not a separate AC — verify as part of
code review):** `apps/api/src/modules/platform-audit/maintenance-mode.ts`'s
`getMaintenanceModeStatus` has a stale comment (`"Read-only — no MFA requirement (matches GET
/audit/events's precedent)"`, line 55) — `GET /audit/events` has always required MFA (Story 9.4's
own design, guard-enforced), so the comment's stated precedent has never actually been true. Fix
the comment to state the real rationale (read-only status endpoint, no mutation, D2.4) without
citing a nonexistent precedent.

---

**AC-M8 — `/platform/audit`'s maintenance-status widget is now reachable end-to-end for an
MFA-unenrolled operator (both dead ends removed together).**
**Given** an MFA-unenrolled platform operator visits `/platform/audit`,
**When** AC-M4 (events list) and AC-M7 (maintenance-mode `GET`) have both landed,
**Then** the page renders successfully: the events list shows the `MfaAwareErrorAlert` with the
"Enable MFA" link (AC-M4) for the `eventsErrorMessage` half, **and**, separately and
independently, the maintenance-status banner (lines 163-189, driven by `maintenanceStatus`/
`maintenanceStatusError`) shows the real "Maintenance mode: inactive" (or active) indicator, NOT
the generic `maintenanceStatusError` fallback — because `GET /maintenance-mode` no longer requires
MFA at all, that half of the `Promise.allSettled` load never rejects for this operator.

**Example (positive):** component test with `data.eventsErrorMessage` set to the MFA message and
`data.maintenanceStatus = {active: false, pendingEntriesCount: 0, ...}`,
`data.maintenanceStatusError = null` → both the "Enable MFA" link (from the events half) AND
"Maintenance mode: inactive" (from the maintenance half) are visible simultaneously — proving the
two error states are independent and AC-M7's fix means the second one never triggers for this
reason.

**Example (edge — before AC-M7 lands, for contrast only, not a shippable state):** if
`GET /maintenance-mode` still required MFA, `maintenanceStatusError` would show the unrelated
hardcoded generic string ("Maintenance mode status unavailable") with zero MFA guidance and the
maintenance-mode action buttons disabled — this is the double-dead-end AC-M7 eliminates; do not
leave this reachable.

---

**AC-M9 — Authz regression guard: non-platform-operator and unauthenticated callers still get
`401`/`403 platform_operator_required` unchanged on every touched route.**
**Given** the five routes touched or referenced by this story (`GET /settings`, `GET /orgs`, `GET
/resource-usage`, `GET /audit/events`, `GET /maintenance-mode`),
**When** a non-platform-operator authenticated user (MFA-enrolled, to isolate the reason —
`enrollUserWithMfa` helper, matching the existing `D2.4/AC-A4` test's pattern) or a fully
unauthenticated request hits any of them,
**Then** the response is unchanged from pre-story behavior: `403 {code:'platform_operator_required'}`
for the authenticated non-operator, `401` for unauthenticated — this story only ever removes or
adds an MFA check, never a platform-operator check, on any route.

**Example (positive — regression, must not change):** `GET /api/v1/platform/maintenance-mode`
called by an MFA-enrolled non-platform-operator → `403 {code:'platform_operator_required'}`,
exactly matching the existing `'D2.4/AC-A4'` test (already covers this for `GET /maintenance-mode`
specifically — verify it still passes; add equivalent coverage for `GET /orgs`/`GET
/resource-usage` only if not already present, since `settings-routes.test.ts`/
`platform-audit/routes.test.ts` already cover their respective routes).

**Example (edge — unauthenticated, no cookie at all):** any of the five routes → `401`, unchanged
— this is `secureRoute`'s own baseline auth check, ordered before both the platform-operator and
MFA checks (`apps/api/src/lib/secure-route.ts`'s `enforceProtectedGuards`), and is not touched by
this story at all.

---

## Independent re-verification note (per this story's own creation task)

Both `/platform/settings/resource-usage` and `/platform/audit` were independently re-inspected
(not assumed from the task prompt) by reading the current `+page.server.ts`/`+page.svelte` pairs
directly:

- **`resource-usage`**: confirmed the **same** defect as `/settings`/`/orgs` — plain `<p
  role="alert">`, and additionally confirmed `MfaAwareErrorAlert` is not even imported into this
  file (unlike the other three, which already import it for a different, mutation-path use).
- **`audit`**: confirmed the same defect on the `eventsErrorMessage` half, plus discovered a
  related-but-distinct second dead end on the same page (`maintenanceStatusError`, driven by `GET
  /maintenance-mode`) that traces back to a regression in `GET /maintenance-mode`'s `requireMfa`
  flag rather than a missing-`MfaAwareErrorAlert` bug — root-caused to commit `f542c9f` overriding
  Story 9.7's own documented design intent to satisfy a pre-existing guard test. This became AC-M7
  (and AC-M8, which verifies both halves of the same page together).

---

## Tasks / Subtasks

Follow this project's TDD convention: write/update the failing test first, confirm it fails for
the expected reason, then implement, per AC.

- [x] **Task 1 — Group T: `isPlatformAuditStorageUnavailableError` classifier (AC-T1)**
  - [x] 1.1 RED: new test file `apps/api/src/lib/audit-or-fail-closed.storage-classifier.test.ts`
    — unit tests for every example in AC-T1 (no DB, no vault). Run, confirm failure (function does
    not exist yet).
  - [x] 1.2 GREEN: implement `isPlatformAuditStorageUnavailableError` in `audit-or-fail-closed.ts`,
    exported. SQLSTATE-class and Node-errno-code constants as module-level `const`s with a comment
    citing this AC.
  - [x] 1.3 Re-run 1.1's tests, confirm green.

- [x] **Task 2 — Group T: wire the classifier into the catch clause (AC-T2 through AC-T7)**
  - [x] 2.1 RED: add AC-T3/AC-T4/AC-T5 new tests. AC-T3 in a new mocked unit test file (mirroring
    `packages/db/src/test-helpers.cleanup-errors.test.ts`'s `vi.mock` style, mocking
    `../modules/platform-audit/write-entry.js`'s `writePlatformAuditEntry`). AC-T4/AC-T5 appended
    to the existing `audit-or-fail-closed.platform-audit.test.ts` (real DB/vault, matching that
    file's existing style). Run, confirm AC-T4/AC-T5 fail (current code queues instead of
    rethrowing); AC-T3 should already pass trivially before the classifier is wired in only if the
    mock throws with maintenance mode active (verify it currently passes for the wrong reason — the
    unconditional catch — then re-verify after 2.2 it passes for the right reason).
  - [x] 2.2 GREEN: change the catch clause: `if (isPlatformAuditStorageUnavailableError(error) &&
    (await isMaintenanceModeActive(tx))) { ...queue...; return }` — check the classifier first
    (cheap, synchronous) before the `isMaintenanceModeActive` DB round-trip, so genuine application
    bugs never pay that extra query.
  - [x] 2.3 Re-run ALL tests in `audit-or-fail-closed.platform-audit.test.ts` (AC-T2, AC-T4, AC-T5,
    AC-T6, AC-T7 — the existing 4 plus 2 new) and the new AC-T3 file. Confirm all green.

- [x] **Task 3 — Group M: `/platform/settings` fix (AC-M1)**
  - [x] 3.1 RED: add/extend a component test for `apps/web/src/routes/(app)/platform/settings/+page.svelte`
    (find or create `settings-page.test.ts` sibling, matching this project's existing
    `render(Page, { props: { data } })` + `@testing-library/svelte` convention — see
    `apps/web/src/routes/members-page.test.ts` for the exact pattern) asserting an "Enable MFA"
    link renders when `data.errorMessage` contains "MFA". Run, confirm failure.
  - [x] 3.2 GREEN: replace the plain `<p>` (lines 136-142) with `<MfaAwareErrorAlert>` per AC-M1.
  - [x] 3.3 Add the AC-M5 regression test (non-MFA message → no link) in the same file. Confirm
    green.

- [x] **Task 4 — Group M: `/platform/settings/orgs` fix (AC-M2)**
  - [x] 4.1 RED: equivalent component test for the orgs page, using `pageError` not
    `data.errorMessage`. Confirm failure.
  - [x] 4.2 GREEN: replace the plain `<p>` (lines 85-91) with `<MfaAwareErrorAlert message={pageError}
    ...>`.
  - [x] 4.3 Confirm the AC-M2 empty-state edge case still passes; add the AC-M5 regression test.

- [x] **Task 5 — Group M: `/platform/settings/resource-usage` fix (AC-M3)**
  - [x] 5.1 RED: equivalent component test for the resource-usage page. Confirm failure.
  - [x] 5.2 GREEN: add the `MfaAwareErrorAlert` import; replace the plain `<p>` (lines 52-58).
  - [x] 5.3 Confirm the AC-M3 warnings-banner edge case still passes; add the AC-M5 regression test.

- [x] **Task 6 — Group M: `/platform/audit` events-list fix (AC-M4)**
  - [x] 6.1 RED: equivalent component test for the audit page's `eventsErrorMessage` half. Confirm
    failure.
  - [x] 6.2 GREEN: replace the plain `<p>` (lines 246-252) with `<MfaAwareErrorAlert
    message={data.eventsErrorMessage} ...>`, reusing the existing import.
  - [x] 6.3 Confirm the AC-M4 empty-state edge case still passes; add the AC-M5 regression test.

- [x] **Task 7 — Group M: backend MFA test-coverage gap closure (AC-M6)**
  - [x] 7.1 RED: add the missing MFA-unenrolled test to `orgs-routes.test.ts`, mirroring
    `settings-routes.test.ts`'s `AC-1` test pattern exactly (register → flip
    `isPlatformOperator` → expire `gracePeriodExpiresAt` → call route). Confirm it currently passes
    against the ALREADY-CORRECT backend (this is documenting existing-but-untested behavior, not a
    behavior change — the "RED" step here is confirming the test is well-formed by first running it
    against a deliberately-broken local edit, e.g. temporarily commenting out `requireMfa: true`, to
    prove the test actually catches a regression, then reverting that temporary edit).
  - [x] 7.2 Repeat 7.1 for `resource-usage-routes.test.ts`.

- [x] **Task 8 — Group M: `GET /maintenance-mode` MFA-flag regression fix (AC-M7, AC-M8, AC-M9)**
  - [x] 8.1 RED: add the new MFA-unenrolled-operator test to `platform-audit/routes.test.ts`
    (mirroring the `orgs`/`resource-usage` pattern from Task 7, adapted to this file's existing
    helpers) asserting `200`, not `403`. Run, confirm it fails against current code (`403
    mfa_required`).
  - [x] 8.2 GREEN: flip `requireMfa: true` → `false` on `GET /maintenance-mode` in `routes.ts`.
  - [x] 8.3 Update `platform-audit-route-audit.test.ts`'s guard test to add the narrow, explicit
    exception for exactly `{method: 'GET', url: '/maintenance-mode'}` (asserting `requireMfa: false`
    for that one route, `requireMfa: true` for every other route in the file) — run the guard test
    alone first to confirm it fails before this edit (proving AC-M7's flag flip alone would break
    CI without this), then confirm it passes after.
  - [x] 8.4 Fix the stale comment in `maintenance-mode.ts`'s `getMaintenanceModeStatus` (line 55).
  - [x] 8.5 Add/verify the AC-M9 non-platform-operator and unauthenticated regression tests across
    all five touched routes — add only where genuinely missing (check each file first).
  - [x] 8.6 Add the AC-M8 component test on the audit page combining both fixes (events MFA alert +
    maintenance-status widget both correctly rendered together).

- [x] **Task 9 — Full verification**
  - [x] 9.1 Run the full API test suite (`apps/api`) — confirm no regressions beyond the
    intentionally-changed tests.
  - [x] 9.2 Run the full web test suite (`apps/web`) — confirm no regressions.
  - [x] 9.3 `make ci` (or equivalent local lint/typecheck/test gate) green.
  - [x] 9.4 Update `deferred-work.md`'s TD9-2 entry and the MFA-dead-end entry to reflect closure
    (do not delete the historical record — mark resolved, cross-reference this story).

---

## Dev Notes

- **Do not touch** `settings-routes.ts`/`orgs-routes.ts`/`resource-usage-routes.ts`'s `GET`
  security blocks, or `platform-admin-route-audit.test.ts` — those are correct and guarded.
  Group M's backend-adjacent work is limited to: two new tests (AC-M6) and one flag + one guard
  update, both scoped to `platform-audit/` (AC-M7).
- **Classifier ordering matters for correctness, not just style:** check
  `isPlatformAuditStorageUnavailableError(error)` before `await isMaintenanceModeActive(tx)` in the
  `&&` — this both avoids an unnecessary DB round-trip for the common case (an application bug,
  which is presumably rarer than a real outage but still shouldn't pay for a query it doesn't need)
  and, more importantly, keeps the two conditions independently testable/readable.
- **Do not add a general `isPlatformAuditApplicationError` or similar inverse helper** — the
  existing code already defaults to "rethrow" for anything the storage classifier doesn't
  recognize; an inverse helper would be redundant and is exactly the kind of speculative
  abstraction this hardening story should avoid.
- **`redactPlatformAuditPayload`'s double-call (once inside `writePlatformAuditEntry`'s own write
  attempt, once again inside the queue branch) is pre-existing and intentionally untouched** —
  after this story's fix, the queue branch is only reached for storage-unavailability errors, so
  the second call's forbidden-key handling becomes a pure defense-in-depth path (a payload could
  coincidentally contain a forbidden key AND the write could fail for an unrelated storage reason)
  rather than the primary path it used to be. Do not remove or simplify it.
- **Svelte component test pattern:** this project already has precedent for testing `+page.svelte`
  files directly with `@testing-library/svelte`'s `render(Page, { props: { data } })`, e.g.
  `apps/web/src/routes/members-page.test.ts` (renders `MembersPage`, mocks an `ApiClientError` with
  `code: 'mfa_required'`, asserts on `MfaAwareErrorAlert`'s rendered output). Reuse this exact
  pattern for all four new/extended page tests in Tasks 3-6 — do not invent a new testing approach.
- **`enrollUserWithMfa` vs. `registerPlatformOperator` test helpers**
  (`apps/api/src/__tests__/helpers/platform-operator-test-helpers.js` and sibling files): the
  latter enrolls MFA by default, which is why existing happy-path tests never exercise the
  unenrolled case — every new MFA-unenrolled test in this story needs the manual
  register-then-flip-`isPlatformOperator`-then-expire-grace-period sequence from
  `settings-routes.test.ts`'s `AC-1` test, not `registerPlatformOperator`. Conversely, use
  `enrollUserWithMfa` (already MFA-enrolled, never platform operator) for AC-M9's
  non-platform-operator negative tests, to keep the 403 reason unambiguous — matches
  `platform-audit/routes.test.ts`'s existing `D2.4/AC-A4` test.
- **This story changes previously-documented behavior on purpose:** Story 9.4's AC-6 text
  explicitly listed "DB constraint violation" as a failure the (then-unconditional) maintenance-mode
  bypass would catch. AC-T4 of this story deliberately narrows that — this is not a bug in this
  story's understanding of AC-6, it is AC-6/AC-15's documented scope being intentionally reduced,
  per TD9-2's own decided fix direction (`deferred-work.md`). Do not "fix" this story to restore the
  old scope.
- **Route-audit guard tests are AST-based, not just regex-on-file-contents** — both
  `platform-admin-route-audit.test.ts` and `platform-audit-route-audit.test.ts` parse each route
  file with the TypeScript compiler and extract the second argument of every `secureRoute(...)`
  call as raw text, then regex-match within that captured text. When adding the AC-M7 exception,
  match on the same captured `call.text` (which already contains the full route config object,
  including `method`/`url`/`security` as sibling keys in one literal) — do not restructure how
  `findSecureRouteCalls` works.

### Project Structure Notes

- No new files needed for Group M (only edits to existing `+page.svelte`/test files).
- Group T needs exactly one new test file (`audit-or-fail-closed.storage-classifier.test.ts`,
  Task 1) plus one new mocked test file or a new `describe` block for AC-T3 (Task 2) — use your
  judgment on whether AC-T3 fits better as its own file (mocking `write-entry.js`) or an addition to
  the classifier test file from Task 1; either is acceptable as long as it doesn't touch the real
  DB (AC-T3 is specifically the case that can't be triggered against a real local Postgres).
- No migrations, no schema changes, no new packages.

### References

- [Source: `_bmad-output/implementation-artifacts/deferred-work.md#Deferred-from-Epic-9-retrospective-2026-07-08-Story-9.7`]
- [Source: `_bmad-output/implementation-artifacts/9-4-platform-operator-audit-log.md#AC-6`, `#AC-15`, `#AC-16`]
- [Source: `_bmad-output/implementation-artifacts/9-7-epic-9-completion-platform-operations-web-ui.md#AC-G4`, `#D2.4`]
- [Source: `_bmad-output/implementation-artifacts/9-7-epic-9-completion-platform-operations-web-ui-adversarial-review.md` Findings 2/3]
- [Source: `apps/api/src/lib/audit-or-fail-closed.ts`]
- [Source: `apps/api/src/modules/platform-audit/routes.ts`, `maintenance-mode.ts`]
- [Source: `apps/api/src/modules/platform-audit/platform-audit-route-audit.test.ts`]
- [Source: `apps/api/src/modules/platform-admin/platform-admin-route-audit.test.ts`]
- [Source: `apps/web/src/lib/components/MfaAwareErrorAlert.svelte`]
- [Source: `apps/web/src/routes/(app)/platform/settings/+page.svelte`, `.../orgs/+page.svelte`, `.../resource-usage/+page.svelte`, `.../audit/+page.svelte`]
- Product surface rules: [Source: `_bmad-output/implementation-artifacts/product-surface-contract.md`]

## Dev Agent Record

### Agent Model Used

GPT-5.6 Sol

### Debug Log References

- TDD RED confirmed for the missing classifier export, application-error queueing, all four
  page-load MFA links, and the maintenance-status MFA gate/route-audit guard.
- AC-M6's existing backend contract was mutation-tested by temporarily disabling each GET route's
  `requireMfa` flag; both new tests failed with 200 instead of 403, then passed after restoration.
- Reconciled AC-T5 per Nestor's 2026-07-10 decision: production forbidden-key sanitization remains
  Story 9.4's strip/warn/continue behavior; non-production assertions are wrapped fail-closed.
- Full API run: 201/202 files and 1837/1839 tests passed. The two failures were unrelated
  `backup.routes.test.ts` rate-limit ordering failures (429 before expected 409); both failing tests
  passed together in isolation (2/2). All eight story-relevant API files passed (75/75).
- Full web behavior run: 112/112 files, 918/918 tests passed. API/web typecheck and lint passed
  (warnings only). `make ci` was not run per user instruction.

### Implementation Plan

- Classify only vault-sealed, Postgres storage/resource, and socket connectivity failures before
  consulting maintenance mode; fail closed for all other write errors.
- Reuse `MfaAwareErrorAlert` on the four platform load-error surfaces and preserve existing
  non-MFA, empty-state, warnings, and maintenance-status behavior.
- Restore the read-only maintenance-status route's no-MFA contract with a narrow AST guard
  exception while retaining platform-operator authorization.

### Completion Notes List

- Implemented all AC-T1–T7 and AC-M1–M9 with red-green regression coverage.
- Preserved Story 9.4's production forbidden-key stripping policy and documented the reconciled
  contract directly in AC-T5.
- Closed both Story 9.7 deferred-work entries without migrations, schema changes, or dependencies.
- Verified the persona path: each MFA-blocked page exposes a working `/settings/security` link;
  `/platform/audit` simultaneously displays the real maintenance status.

### File List

- `_bmad-output/implementation-artifacts/9-8-platform-admin-mfa-gaps-and-audit-bypass-hardening.md`
- `_bmad-output/implementation-artifacts/deferred-work.md`
- `_bmad-output/implementation-artifacts/sprint-status.yaml`
- `apps/api/src/lib/audit-or-fail-closed.ts`
- `apps/api/src/lib/audit-or-fail-closed.platform-audit.test.ts`
- `apps/api/src/lib/audit-or-fail-closed.storage-bypass.test.ts`
- `apps/api/src/lib/audit-or-fail-closed.storage-classifier.test.ts`
- `apps/api/src/modules/platform-admin/orgs-routes.test.ts`
- `apps/api/src/modules/platform-admin/resource-usage-routes.test.ts`
- `apps/api/src/modules/platform-audit/maintenance-mode.ts`
- `apps/api/src/modules/platform-audit/platform-audit-route-audit.test.ts`
- `apps/api/src/modules/platform-audit/routes.test.ts`
- `apps/api/src/modules/platform-audit/routes.ts`
- `apps/web/src/routes/(app)/platform/audit/+page.svelte`
- `apps/web/src/routes/(app)/platform/audit/audit-page.test.ts`
- `apps/web/src/routes/(app)/platform/settings/+page.svelte`
- `apps/web/src/routes/(app)/platform/settings/settings-page.test.ts`
- `apps/web/src/routes/(app)/platform/settings/orgs/+page.svelte`
- `apps/web/src/routes/(app)/platform/settings/orgs/orgs-page.test.ts`
- `apps/web/src/routes/(app)/platform/settings/resource-usage/+page.svelte`
- `apps/web/src/routes/(app)/platform/settings/resource-usage/resource-usage-page.test.ts`

## Change Log

- 2026-07-10: Implemented Story 9.8 audit-bypass narrowing and platform-admin MFA guidance via
  strict TDD; reconciled AC-T5 to preserve production sanitization; moved story to review.
