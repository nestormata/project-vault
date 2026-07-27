# Story 15.2: Configure Organization Default Locale for New Users

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an Organization Admin,
I want to set a default display language for newly invited users,
so that new team members land in the right language from their first login without each person having to change it manually.

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `both` (backend PATCH `defaultLocale` setting + web Settings > Users UI control, same story) |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A — web UI ships in this story |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | See below |

### Persona journey stub

**Who:** Riley-admin (org role `owner` or `admin` only — this is an org-wide setting, not a personal preference).

**Steps:**
1. Riley opens **Settings → Users** (the existing admin-only settings page that already hosts the machine-key and user dormancy-threshold controls — Story 7.2/8.3 precedent).
2. Riley sees a new "Default language for new users" control alongside the dormancy sections, listing the currently supported locales (English, Español — same `SUPPORTED_LOCALES` set as Story 15.1).
3. Riley selects "Español" and saves. The org's `default_locale` column updates; a confirmation message shows the new value was saved (mirroring the dormancy-threshold controls' own save-confirmation pattern — this control does **not** read back or pre-select the org's current value, matching the existing, deliberate "set-only, no GET readback" precedent already used by `machine-key-settings`/`user-dormancy-settings` on this same page).
4. Alex, a brand-new hire, is invited to Riley's org and accepts the invitation by registering a new account (they had no prior Project Vault account). Alex's very first login renders the UI in Spanish — no manual language change needed.
5. Morgan, an existing Project Vault user (already has an account from a different org), is invited to Riley's org and accepts. Morgan's own already-established `users.locale` is untouched — the org default only seeds a *brand-new* user's initial value, never overwrites an existing user's preference.
6. Alex later opens Settings → Language (Story 15.1) and switches to English. From that point on, Alex's individual choice wins — Riley changing the org default again has no further effect on Alex.

**Expected UI outcome:** An org-admin-only control that sets (but does not display) the org's default locale for future invitees; zero effect on any already-registered user's own locale.

## Acceptance Criteria

1. **OrgAdmin sets an org default locale.** Given an OrgAdmin (`owner` or `admin` org role), when they submit a valid locale from the supported set via `PATCH /api/v1/organizations/:orgId/default-locale-settings`, then `organizations.default_locale` is updated to that value.
   - *Positive:* An `admin`-role user PATCHes `{ "defaultLocale": "es" }` for their own org; the response returns `{ data: { orgId, defaultLocale: "es" } }` and the DB row reflects `es`.
   - *Positive:* An `owner`-role user performs the same PATCH; succeeds identically (mirrors `minimumRole: 'admin'` semantics already used by `machine-key-settings`/`user-dormancy-settings` — `owner` outranks `admin` in `roleRank`, so both pass).
   - *Edge/failure:* A `member` or `viewer` role attempting this PATCH receives `403` (insufficient role) — no column change occurs. Add a test asserting the DB value is unchanged after a rejected attempt.
   - *Edge/failure:* A PATCH with an unsupported locale code (e.g., `"xx"`, `"en-US"`, empty string) is rejected `422` by a strict zod enum (reusing `SUPPORTED_LOCALES` from `packages/shared`, same source of truth as Story 15.1 — do not hardcode a second enum) *before* touching the database. Also test a `.strict()` extra-field rejection (e.g., a stray `orgId` in the body) to guard against the same body-tampering class Story 15.1 AC 8 tested for the personal-locale endpoint.
   - *Edge/failure:* PATCHing `:orgId` that does not match the caller's own `secureCtx.auth.orgId` returns `404` (not `403`) — same non-leaking cross-org pattern `updateOrgDormancyColumn` already implements for the two existing settings routes; add a test using a second org's `orgId` with a valid admin token from the first org.

2. **New invited user (brand-new account) inherits the org default at registration.** Given an org has a configured `default_locale` of `"es"`, when a brand-new user (no prior account) registers by accepting a project invitation for that org, then their newly-created `users.locale` row is set to `"es"`, not the column's own hardcoded `'en'` default.
   - *Positive:* OrgAdmin sets `defaultLocale: "es"`. A new email address accepts an invitation to that org via `POST /api/v1/auth/register` with `invitationToken` set. The resulting user row has `locale = 'es'`. Confirm via a subsequent `GET /api/v1/users/me` returning `locale: "es"` on first login — no manual Settings → Language action taken.
   - *Edge:* An org that has never called the PATCH from AC 1 has `default_locale` at its own column default (`'en'`) — a new invited user registering into that org gets `locale = 'en'`, identical to pre-Story-15.2 behavior. This must require **no special-case code** — it falls out naturally from reading `organizations.default_locale` at registration time, whatever its current value is (including the un-set default).
   - *Edge:* Self-signup (no invitation token — a brand-new user creating a **brand-new org**, the existing "first user becomes owner" path in `registerUser`) also reads the freshly-created org's own `default_locale`, which is always `'en'` at creation time (no PATCH could have run yet against an org that doesn't exist yet) — so self-signup owners keep getting `locale = 'en'`, unchanged from current behavior. Add a regression test asserting this — do not let this path accidentally read some *other* org's default or skip locale assignment entirely.

3. **Existing user accepting an invitation is unaffected.** Given a user who **already has an account** (already registered, already has a `users.locale` value — possibly customized via Story 15.1), when they accept an invitation to join an *additional* org (the `POST /api/v1/invitations/:token/accept` flow in `token-routes.ts`, which operates on an authenticated existing session and never inserts a new `users` row), then their `users.locale` is left completely untouched, regardless of the joined org's `default_locale`.
   - *Positive:* User Morgan already has `locale = 'en'` (never customized). Morgan accepts an invitation to join Org B, which has `default_locale = 'es'`. After acceptance, Morgan's `users.locale` is still `'en'` — confirm via `GET /api/v1/users/me`.
   - *Edge:* Explicitly assert `token-routes.ts`'s accept handler performs no `UPDATE users SET locale = ...` of any kind — this AC exists specifically to prevent someone "helpfully" wiring org-default assignment into the wrong invitation-acceptance code path (there are two: `registerUser`'s invitation branch for brand-new accounts, and `token-routes.ts`'s accept endpoint for already-authenticated existing accounts — only the former is in scope).

4. **Individual preference always overrides the org default going forward.** Given a user whose initial locale was seeded from an org default, when they later change their own locale via `PATCH /api/v1/users/me/locale` (Story 15.1), then their individual choice persists and is never reset by a subsequent org-default change.
   - *Positive:* Alex is seeded with `locale = 'es'` from the org default at registration, then changes to `'en'` via Settings → Language. Riley (OrgAdmin) later changes the org default to `'fr'`-equivalent-value-in-supported-set (or re-sets `'es'`) — Alex's own row remains `'en'`, unaffected. This requires no new code in this story beyond *not* writing any "re-apply org default to existing members" logic — confirm by testing that an org-default PATCH (AC 1) triggers no writes to any `users` row.
   - *Edge:* This must hold even when the OrgAdmin who changes the org default is the *same* user who was seeded by the *old* default and has never personally changed their own locale — an OrgAdmin changing the org's future default must not retroactively change their own already-seeded value. Add a test: an admin with `locale = 'en'` (seeded at their own registration) PATCHes the org default to `'es'`; the admin's own `users.locale` remains `'en'` after the call.

5. **Rate limiting matches existing org-settings precedent.** Given repeated `PATCH /api/v1/organizations/:orgId/default-locale-settings` requests, when a caller exceeds the existing per-route rate-limit window, then the endpoint throttles.
   - *Positive:* A normal admin changing the org default once (or a couple of times while configuring the org) always succeeds.
   - *Edge/failure:* Reuse the exact `rateLimit: { max: 10, timeWindowMs: 60_000 }` config already applied to `machine-key-settings`/`user-dormancy-settings` (`organization-settings-routes.ts`) — do not invent a different threshold. Rapid-fire scripted PATCHes past the 10th within 60s receive `429`. Mirror the existing dormancy-settings rate-limit test structure.

6. **Org default locale changes are audited.** Given a successful org-default-locale change, when the update commits, then a human audit log entry is written recording the previous and new default.
   - *Positive:* Changing the org default from `en` to `es` writes an audit entry with `eventType: 'organization.default_locale_updated'` and a payload containing `{ previousDefaultLocale: 'en', newDefaultLocale: 'es' }` — same shape and same `writeHumanAuditEntryOrFailClosed` call-site convention as `machine-key-settings`'s `organization.machine_key_settings_updated` event, registered inline in the route (not a shared helper — `route-audit.test.ts`'s static scan requires the literal call visible per-route, same reason `updateOrgDormancyColumn` stops short of writing the audit row itself).
   - *Edge/failure:* If the audit write fails, the settings change itself must not silently succeed — the whole transaction (column update + audit write) rolls back together and the client receives an error, not a false "saved" response. Add a test mocking `writeHumanAuditEntry` to reject once and asserting both the audit failure AND that `organizations.default_locale` reverted (transaction rollback), matching Story 15.1 AC 9's fail-closed test pattern.
   - **New-user-registration seeding (AC 2) is a different, unaudited event** — `registerUser`'s existing `AuditEvent.USER_REGISTERED` / `AuditEvent.PROJECT_INVITATION_ACCEPTED` entries already fire and already capture the new user; do not add a second audit write purely for "locale was seeded from org default," since it is an implementation detail of registration, not a standalone admin action. Confirm no duplicate/extra audit row appears in the registration test from AC 2.

7. **Migration compatibility and RLS.** Given the new `organizations.default_locale` column, when `pnpm check-migration-compatibility` and `make check-rls` run, then both pass clean — the migration is additive (new `NOT NULL DEFAULT 'en'` column + CHECK constraint, no data loss, no destructive statement) and `organizations` requires no RLS policy change (it is the tenant-root table itself, already outside `check-rls-coverage.ts`'s per-`org_id`-column heuristic — same category as the pre-existing `machineKeyDormancyThresholdDays`/`userDormancyThresholdDays` columns on this same table).
   - *Positive:* `pnpm check-migration-compatibility` reports "no destructive statements in any committed migration — OK" after the new migration is added.
   - *Edge:* Confirm the next free migration index at implementation time via `packages/db/src/migrations/meta/_journal.json` before claiming a number — Story 15.1 itself was renumbered `0055 → 0056` after a same-number collision with a concurrently-merged branch (see its Change Log); this story's Dev Notes below claim `0057` as of story-creation time, but re-verify before writing the migration file.

8. **Concurrent org-default changes are last-write-wins (no locking needed).** Given two OrgAdmins in the same org submit conflicting default-locale changes concurrently, when both PATCHes are processed, then the last one to commit determines the final `organizations.default_locale` value — no version column, no optimistic-locking conflict response.
   - *Positive:* Two sequential PATCHes (`es` then `en`) from two different admin sessions both succeed with `200`; the final DB value is `en` (the second to commit).
   - *Edge:* This is explicitly **not** a race that needs serialization — unlike credential-rotation state, an org-wide display-language default has no correctness invariant broken by last-write-wins (identical reasoning to Story 15.1's own "Concurrent access" Dev Note for the personal-locale endpoint). No test asserting a specific interleaving order is required beyond confirming both requests succeed and the DB ends in a self-consistent single valid-enum state (never a corrupted/partial value).

## Tasks / Subtasks

- [x] **Task 1: Database — add `organizations.default_locale`** (AC: 1, 2, 7)
  - [x] 1.1 Verify the next free migration index against `packages/db/src/migrations/meta/_journal.json` (expected `0057` as of story creation, immediately following Story 15.1's renumbered `0056_users_locale_preference.sql` — **re-check at implementation time**, do not assume).
  - [x] 1.2 Add migration `packages/db/src/migrations/00NN_organizations_default_locale.sql`: `ALTER TABLE organizations ADD COLUMN default_locale text NOT NULL DEFAULT 'en'` + a named CHECK constraint restricting values to the supported set (`'en'`, `'es'`), mirroring `users_locale_check` (Story 15.1) and the existing `organizations_dormancy_threshold_check`/`organizations_user_dormancy_threshold_check` naming convention on this same table (e.g. `organizations_default_locale_check`).
  - [x] 1.3 Add `defaultLocale: text('default_locale').notNull().default('en')` (+ matching `check(...)`) to `packages/db/src/schema/organizations.ts`, with a comment cross-referencing `SUPPORTED_LOCALES` (same cross-reference style as Story 15.1's `users.locale` column comment) and explicitly noting this seeds — but never overrides — `users.locale` at registration time only.
  - [x] 1.4 Follow the established hand-written-migration convention (this repo's `meta/` snapshot chain is broken past `0033_snapshot.json` — documented in Story 15.1's Dev Notes; do not attempt `drizzle-kit generate`): hand-write the SQL migration and append a matching `_journal.json` entry.
  - [x] 1.5 `pnpm check-migration-compatibility` passes clean; apply via `make db-migrate` against a live Postgres instance and confirm the column + constraint exist.

- [x] **Task 2: Backend — org default-locale schema + PATCH route** (AC: 1, 5, 6)
  - [x] 2.1 `OrgDefaultLocaleSettingsBodySchema = z.object({ defaultLocale: z.enum(SUPPORTED_LOCALES) }).strict()` in `apps/api/src/modules/org/organization-settings-schema.ts` (same file as the two existing dormancy schemas — this module's established multi-setting-in-one-file convention), importing `SUPPORTED_LOCALES` from `@project-vault/shared` (Story 15.1's source of truth — do not redefine).
  - [x] 2.2 `OrgDefaultLocaleSettingsResponseSchema = z.object({ data: z.object({ orgId: z.uuid(), defaultLocale: z.string() }) })`.
  - [x] 2.3 Register `PATCH /:orgId/default-locale-settings` in `apps/api/src/modules/org/organization-settings-routes.ts` (third registration in this file, alongside `machine-key-settings`/`user-dormancy-settings`), `minimumRole: 'admin'`, `requireMfa: true`, `rateLimit: { max: 10, timeWindowMs: 60_000, key: 'PATCH /api/v1/organizations/:orgId/default-locale-settings' }`, `writeAuditEvent: false` (inline audit write per AC 6/route-audit.test.ts convention).
  - [x] 2.4 **Decision (post-elicitation, see Pre-Mortem Dev Note below): do not generalize `updateOrgDormancyColumn<K>`.** Write a small parallel handler (`updateOrgDefaultLocaleColumn`) following the identical shape (params/body parse → cross-org 404 guard → read-previous-value → `UPDATE ... RETURNING` → inline audit write) rather than widening the existing helper's `Record<K, number>` constraint to `number | string`. Touching a helper two already-`done` stories' routes depend on, purely to save ~15 lines on a third route, is a regression risk this story's own scope doesn't need to take on.
  - [x] 2.5 Inline `writeHumanAuditEntryOrFailClosed(secureCtx.tx, { resourceType: 'organization', orgId, actorUserId, eventType: 'organization.default_locale_updated', resourceId: updated.id, payload: { previousDefaultLocale, newDefaultLocale }, request: req })` — note this requires reading the **previous** value before the update (the two existing dormancy routes don't need this since their audit payload only reports the new value; read-old-then-update-then-audit, all inside the same transaction).
  - [x] 2.6 `apps/api/src/modules/org/organization-settings-routes.test.ts` (or a new sibling test file matching this module's existing per-setting test file split, e.g. `default-locale-settings-routes.test.ts`) — integration tests covering every AC 1/5/6/7 edge case: role gating (403 for member/viewer), cross-org 404, invalid-locale/`.strict()` 422, rate-limit 429, audit-fail-closed rollback, migration-compatibility check.

- [x] **Task 3: Backend — seed `users.locale` from org default at registration** (AC: 2, 3, 4)
  - [x] 3.1 In `apps/api/src/modules/auth/service.ts`, extend `resolveRegistrationOrg`'s return type to include `defaultLocale: string` (read `organizations.defaultLocale` in the same `SELECT` already performed for the invitation branch; for the self-signup/new-org branch, the freshly-inserted org row already carries the column's own `'en'` default — select or return it explicitly rather than hardcoding `'en'` a second time, to avoid the two branches drifting if the column default ever changes).
  - [x] 3.2 Thread the resolved `defaultLocale` through to `insertUserWithPlatformOperatorBootstrap` → `insertUserRow`, adding `locale: fields.locale` to the `.values({...})` call in `insertUserRow` (currently only sets `email`, `passwordHash`, `isPlatformOperator`).
  - [x] 3.3 Do **not** touch `apps/api/src/modules/invitations/token-routes.ts`'s accept handler (AC 3) — it never inserts a `users` row and must remain untouched.
  - [x] 3.4 `apps/api/src/modules/auth/service.test.ts` (or wherever `registerUser`/`insertUserRow` is currently tested) — add cases for AC 2 (invited-new-user inherits org default, including the "org never configured a default" edge and the "self-signup new org" edge) and AC 4 (org-default change after registration doesn't retroactively affect the already-registered user, including the OrgAdmin-changing-their-own-future-default edge).

- [x] **Task 4: Web — Settings > Users "Default language for new users" control** (AC: 1)
  - [x] 4.1 Add `updateOrgDefaultLocale(fetchFn, orgId, defaultLocale)` to `apps/web/src/lib/api/organization-settings.ts`, following the exact `updateMachineKeyDormancyThreshold`/`updateUserDormancyThreshold` shape (including their documented "set-only, no GET readback" precedent and rationale comment — replicate that same disclosure comment for this new function, do not silently omit it).
  - [x] 4.2 Add a new section to `apps/web/src/routes/(app)/settings/users/+page.svelte`, styled identically to the existing "Machine key dormancy alerts"/"User dormancy alerts" sections (same heading/label/select/button/save-confirmation/error-message pattern), rendering all `SUPPORTED_LOCALES` as options (reuse the same locale-name-mapping approach `apps/web/src/routes/(app)/settings/language/` uses in Story 15.1, e.g. `SUPPORTED_LOCALE_DISPLAY_NAMES`) instead of a numeric `DormancyThresholdOptions`-style dropdown.
  - [x] 4.3 Gate visibility identically to the existing dormancy sections (`canManage` = `orgRole === 'owner' || orgRole === 'admin'`, already computed in `+page.server.ts`) — no new server-load logic needed.
  - [x] 4.4 Add/extend `apps/web/src/routes/(app)/settings/users/users-page.test.ts` with component tests for the new control (renders locale options, calls the PATCH client on save, shows the save confirmation, shows an error message on failure) — follow the existing dormancy-control test structure in this same file.

- [x] **Task 5: RLS, coverage, and CI**
  - [x] 5.1 Confirm `organizations` needs no RLS migration (Task 1.3's comment documents why — it is the tenant-root table, same category as its own pre-existing dormancy-threshold columns). `make check-rls` passes clean.
  - [x] 5.2 `pnpm check-migration-compatibility`, `make check-rls`, `apps/api`'s `route-audit.test.ts` (new route's MFA-requirement and audit-classification checks pass), full `packages/db` suite, full `packages/shared` suite (if `SUPPORTED_LOCALES` needs no changes here, confirm no regression), full `apps/api` suite, full `apps/web` suite all green; `apps/web`/`apps/api` `tsc --noEmit` and `eslint .` both clean.
  - [x] 5.3 **(post-elicitation, Failure Mode Analysis)** Confirm via `make db-migrate` + a full `apps/api` registration test run that the migration is applied *before* the code depending on it runs — unlike Story 15.1's `users.locale` (read only by a passive settings page nobody hits until they opt in), this story's `organizations.default_locale` is read on **every single registration**, the hottest and most availability-critical write path in the app. A missing-column error here would 500 every new signup/invite-acceptance instance-wide, not just degrade one settings page. No code change required (this repo's existing migrate-then-deploy operational convention already covers it) — this subtask exists to make sure the dev/reviewer explicitly confirms that ordering holds for this story rather than assuming it by default, and to flag it prominently to whoever writes the deployment/rollout notes.

## Dev Notes

### Relationship to Story 15.1 (build on, do not duplicate)

Story 15.1 (`_bmad-output/implementation-artifacts/15-1-select-and-use-a-preferred-display-language.md`, status `done`) shipped `users.locale` (migration `0056`, `NOT NULL DEFAULT 'en'`, CHECK-constrained to `SUPPORTED_LOCALES`), `SUPPORTED_LOCALES`/`SUPPORTED_LOCALE_DISPLAY_NAMES`/`isSupportedLocale` in `packages/shared/src/constants/locales.ts`, and the self-service `PATCH /api/v1/users/me/locale` endpoint. **This story reuses that exact column and constant set — it does not introduce a new locale enum, a new column on `users`, or a new frontend i18n mechanism.** 15.1's own Dev Notes explicitly anticipated this story: *"Story 15.2 will set the initial value of this same column at invite-acceptance time; it does not need a separate 'has the user customized this' flag."* This story is purely: (a) a new `organizations.default_locale` column, (b) an admin-only PATCH to set it, and (c) one wiring change at the point `users.locale` is first inserted during registration.

### Architecture compliance (source-cited)

- **No new backend module or shared data model for Epic 15** — per the architecture's Epic Traceability Matrix, locale preference lives as plain columns on `users` (15.1) / `organizations` (this story). [Source: `_bmad-output/planning-artifacts/architecture.md` line 1045]
- **FR119** ("Organization Admins configure a default locale for newly invited users") is this story's sole PRD requirement. [Source: `_bmad-output/planning-artifacts/prd.md` lines 1159-1161; `epics.md` line 183]
- **Scope boundary, explicit in the epic:** *"Story 15.1 (user selects a personal display language) vs. Story 15.2 (org sets a default for new users) — these are different mechanisms; keep them distinct."* Do not add any "re-seed existing members on org-default change" behavior — epics.md's own AC for this story states the org default only seeds the *initial* value. [Source: `epics.md` lines 2674-2694]

### File structure / existing patterns to follow (do not reinvent)

- **Org-scoped settings PATCH pattern:** `apps/api/src/modules/org/organization-settings-schema.ts` + `organization-settings-routes.ts` — this story is a **third** setting added to these same two files, following the exact `machineKeyDormancyThresholdDays`/`userDormancyThresholdDays` precedent (schema `.strict()`, route `minimumRole: 'admin'` + `requireMfa: true` + inline fail-closed audit write). Do not create a new module.
- **`organizations` schema today:** `packages/db/src/schema/organizations.ts` already has two precedent enum/range-constrained settings columns with named CHECK constraints on this exact table — follow that pattern for `default_locale` exactly as Story 15.1 followed it for `users.locale`.
- **Registration flow today:** `apps/api/src/modules/auth/service.ts`'s `registerUser` → `resolveRegistrationOrg` (resolves the target org, either from an invitation or newly-created) → `insertUserWithPlatformOperatorBootstrap` → `insertUserRow` (the actual `INSERT INTO users`). The org's `defaultLocale` must be resolved in `resolveRegistrationOrg` (it already loads the org row or creates one) and threaded through unchanged to `insertUserRow`'s `.values({...})`.
- **Deliberate "no GET readback" precedent already exists on this exact settings page:** `apps/web/src/lib/api/organization-settings.ts`'s existing comment on `updateMachineKeyDormancyThreshold` explains and accepts this UX tradeoff for the two existing settings. Follow the same tradeoff for `defaultLocale` rather than introducing an inconsistent new GET endpoint for only this one setting — do not add a `GET /:orgId/default-locale-settings` route.
- **Web locale-name display:** `apps/web/src/routes/(app)/settings/language/` (Story 15.1) already has the pattern for mapping `SUPPORTED_LOCALES` codes to human-readable names (`SUPPORTED_LOCALE_DISPLAY_NAMES`) — reuse it verbatim for the new admin control's option labels, do not re-derive display names.

### RLS / tenant isolation

`organizations` is the tenant-root table itself — it has an `id` column, not an `org_id` column, so it is structurally outside `check-rls-coverage.ts`'s per-org-column heuristic scan (same reasoning already documented for its pre-existing `machineKeyDormancyThresholdDays`/`userDormancyThresholdDays` columns; also the same category of exclusion as `platform_audit_events` etc. in `EXCLUDED_TABLES`, though `organizations` itself isn't even in that set because the heuristic never flags it in the first place — it has no `org_id` column to trigger the scan). Cross-tenant isolation for the new PATCH route is enforced at the application layer exactly like the two existing dormancy routes: `:orgId` must equal `secureCtx.auth.orgId` or the request 404s (AC 1).

### Concurrent access

Same reasoning as Story 15.1's own "Concurrent access" Dev Note: this is a simple last-write-wins settings field, no optimistic locking warranted (AC 8).

### Audit behaviour

Two genuinely distinct audit surfaces in this story, and they must not be conflated (AC 6):
1. The OrgAdmin's act of *changing the org default* — a new `organization.default_locale_updated` human audit event, fail-closed, same transaction as the column update.
2. A *new user's registration* — already fully covered by `registerUser`'s existing `AuditEvent.USER_REGISTERED`/`AuditEvent.PROJECT_INVITATION_ACCEPTED` entries. The fact that the new user's `locale` happened to be seeded from the org default is an implementation detail of that existing event, not a new auditable action — do not add a third audit write.

### Session lifecycle

No auth/session-lifecycle changes in this story — the new PATCH route uses the existing `secureRoute` MFA/session machinery identically to the two sibling settings routes; registration's session/token issuance (`buildRegisterResult` and beyond) is untouched, since this story only changes what value gets written into the new user's `locale` column at insert time, not the registration/login flow itself.

### Rate limits

Reuse the existing `{ max: 10, timeWindowMs: 60_000 }` config verbatim (AC 5) — do not invent a new threshold for a settings-change route that behaves identically in shape to its two existing siblings.

### Migration compatibility

Additive column + CHECK constraint only, same shape as Story 15.1's `0056_users_locale_preference.sql` — `pnpm check-migration-compatibility` must report clean. **Re-verify the next free migration index at implementation time** (Task 1.1) — Story 15.1 itself was renumbered `0055 → 0056` after a same-number collision with a concurrently-merged branch (Story 13.4's `0055`), so treat any number claimed here as provisional until confirmed against `meta/_journal.json` immediately before writing the file.

### Operational logging

No new operational (`pino`) log lines are required by this story — the audit trail (AC 6) is the human-facing record of this admin action; there is no plugin-egress- or job-scheduler-style background process here that would additionally warrant a `WARN`/`ERROR` operational log line.

### Pre-Mortem Analysis (post-elicitation)

Imagining this story shipped and caused a production incident — the three most plausible failure modes, and their mitigations already folded into the tasks/ACs above:

1. **Registration 500s instance-wide because the migration lagged the code deploy.** Unlike Story 15.1's passive `users.locale` (only read when a user opts into Settings → Language), this story's `organizations.default_locale` is read on the hottest path in the app: every registration. A missing-column error here breaks *all* signups and invite-acceptances, not one settings page. Mitigated by Task 5.3 (explicit migrate-before-deploy confirmation) — treat this column's rollout with the same care as any other hot-path schema change, not with 15.1's more relaxed precedent.
2. **A "helpful" refactor of `updateOrgDormancyColumn` breaks the two already-`done` dormancy settings routes.** Generalizing that shared helper's type parameter to accommodate a string column is an obvious-looking simplification that risks a subtle regression in code two prior stories already shipped and tested. Mitigated by Task 2.4's explicit decision to duplicate the handler shape instead.
3. **A future third locale is added to `SUPPORTED_LOCALES` but the `organizations_default_locale_check` CHECK constraint is forgotten (only `users_locale_check` gets updated).** Both constraints hardcode `IN ('en', 'es')` independently of the shared TS constant, so they can silently drift. Mitigated by Task 1.3's requirement to cross-reference `SUPPORTED_LOCALES` in the column comment — call out explicitly in code review of any future locale-addition story that **both** CHECK constraints must move together, not just the one on `users`.

### Security review (hacker / defender / auditor pass, post-elicitation)

- **Hacker attempt — IDOR on the settings PATCH:** Try to change another org's default locale by passing a different `:orgId`. **Defense:** the cross-org 404 guard (AC 1) — identical to the two existing dormancy-settings routes' own defense, no new attack surface introduced.
- **Hacker attempt — force a targeted org's locale onto your own registration:** Try to influence which org's `default_locale` seeds your new account by manipulating registration input. **Defense:** the org is never client-supplied directly — it's resolved either from a cryptographically-random invitation token (already validated server-side before any locale read happens) or freshly created for self-signup. There is no code path where a registering caller supplies an arbitrary `orgId` that gets read for `defaultLocale`.
- **Hacker attempt — role escalation via a race on org role between token issuance and the PATCH:** Try to retain access to the PATCH endpoint after being demoted from admin to member. **Defense:** out of scope — `secureRoute`'s `minimumRole` check reads the caller's *current* role from the request's own auth context on every request, same as every other role-gated route in this codebase; no new race is introduced by this story specifically.
- **Auditor check:** the new audit event (`organization.default_locale_updated`) carries only locale codes (no PII) in its payload, goes through the same `writeHumanAuditEntryOrFailClosed` HMAC-chained mechanism as every other admin settings change — no special-casing needed, existing audit-integrity guarantees apply automatically.

### Architecture Decision Record — no GET readback for the org default (post-elicitation)

- **Option A — Add `GET /:orgId/default-locale-settings` (rejected):** Would be the *only* one of the three org-settings-page controls with a GET readback, creating an inconsistent UX/API pattern on the same settings page for no strong reason — the existing two dormancy-threshold controls already accepted "set-only, disclosed via UI copy" as sufficient, and their own client-code comment documents that tradeoff as deliberate, not an oversight this story should silently "fix."
- **Option B — Fold `defaultLocale` into some future general org-profile GET (rejected for this story):** No such endpoint exists yet; inventing one now to serve a single field would be scope creep well beyond FR119.
- **Option C — Set-only PATCH, no readback, same UI-copy disclosure pattern as the two existing settings (chosen):** Consistent with the page's existing precedent, zero new endpoints beyond the one PATCH this story actually needs.

### Architecture Decision Record — last-write-wins, no version column (post-elicitation)

- **Option A — Optimistic locking / version column on `organizations` for this field (rejected):** No correctness invariant is broken by two admins' concurrent changes racing — unlike, say, a rotation checklist's state machine, "which locale did the org end up with" has no notion of a conflict to detect or reject. Adding a version column would be unjustified complexity for a preference field.
- **Option B — Last-write-wins, identical to Story 15.1's personal-locale field (chosen):** Simpler, consistent with the sibling feature's own already-accepted precedent (AC 8).

### Rejected scope (post-elicitation, Challenge from Critical Perspective)

The following were explicitly considered and rejected to keep this story aligned with FR119/epics.md's own scope boundary — do not implement them as part of this story even if they seem like natural extensions:

- **Bulk-applying a new org default to already-registered members.** epics.md's own AC is explicit: the org default only seeds a *new* user's *initial* value; an individual's already-set preference always wins going forward (AC 4). A "re-apply to everyone" admin action is a different feature with different consent/UX implications (silently changing an already-active user's UI language without their action) and is out of scope.
- **Surfacing the org's default locale in the invitation-peek response** (`GET /api/v1/invitations/:token`) so an invitee could preview their expected language before accepting. Plausible future UX polish, but not required by any AC here and would touch a currently-stable, unauthenticated public endpoint (`token-routes.ts`'s peek handler) for a cosmetic benefit only — deliberately left out.
- **Requiring a stronger-than-MFA control (e.g., a second-admin approval) for changing the org default.** This is a low-blast-radius preference setting, not a security-sensitive control like a KMS unseal mode or SSO domain change — the existing `minimumRole: 'admin'` + `requireMfa: true` bar (identical to the two sibling settings routes) is proportionate and consistent.

### Testing standards

- Integration tests co-located with the existing org-settings test files in `apps/api/src/modules/org/` (or `apps/api/src/__tests__/` if that's where `organization-settings-routes.test.ts`'s siblings currently live — check at implementation time) using `withTestOrg()`'s multi-role fixtures for the role-gating cases.
- Every AC above must have at least one corresponding automated test; the role-gating (AC 1), existing-user-unaffected (AC 3), no-retroactive-reseed (AC 4), and audit-fail-closed (AC 6 edge) cases specifically must not be skipped — these are the disaster-prevention cases most likely to be hand-waved, following the same discipline Story 15.1's Dev Notes called for.

### Project Structure Notes

- No conflicts detected with the existing unified project structure — this story adds no new files beyond one migration, one test file (or extends an existing one), and touches four existing files (`organizations.ts` schema, `organization-settings-schema.ts`, `organization-settings-routes.ts`, `auth/service.ts`, `organization-settings.ts` web client, `settings/users/+page.svelte`) — every touch point already exists and already hosts an analogous precedent.
- This story is intentionally small relative to Story 15.1 — no new i18n infrastructure, no new frontend route, no new module. The bulk of the implementation risk is in Task 3 (registration wiring), not the settings UI.

### References

- [Source: `_bmad-output/planning-artifacts/epics.md#Epic 15 — Localization`, lines 2633-2694] — epic scope, FR117-119, Story 15.2 ACs as originally scoped, Story 15.1 boundary.
- [Source: `_bmad-output/planning-artifacts/prd.md` lines 1159-1161] — FR117/FR118/FR119 definitions.
- [Source: `_bmad-output/planning-artifacts/architecture.md` line 1045] — no-new-backend-module decision (Epic Traceability Matrix).
- [Source: `_bmad-output/implementation-artifacts/15-1-select-and-use-a-preferred-display-language.md`] — `users.locale` column, `SUPPORTED_LOCALES`, personal-locale endpoint, explicit forward-compatibility note for this story.
- [Source: `packages/db/src/schema/organizations.ts`, `packages/db/src/schema/users.ts`] — existing schema and enum-constrained-column precedent on both tables.
- [Source: `apps/api/src/modules/org/organization-settings-schema.ts`, `organization-settings-routes.ts`] — settings-route convention to extend (third setting in this file).
- [Source: `apps/api/src/modules/auth/service.ts` — `resolveRegistrationOrg`, `insertUserRow`, `insertUserWithPlatformOperatorBootstrap`, `registerUser`] — registration wiring point.
- [Source: `apps/api/src/modules/invitations/token-routes.ts`] — existing-user invitation-accept path, confirmed out of scope (AC 3).
- [Source: `apps/web/src/lib/api/organization-settings.ts`, `apps/web/src/routes/(app)/settings/users/+page.svelte`] — UI/route conventions to replicate, including the deliberate no-GET-readback precedent.
- [Source: `packages/db/src/check-rls-coverage.ts`] — RLS exclusion precedent for the tenant-root `organizations` table.
- Product surface rules: [Source: `_bmad-output/implementation-artifacts/product-surface-contract.md`]

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (claude-sonnet-5) — story authored via bmad-create-story, 2026-07-27. Implemented via bmad-dev-story, 2026-07-27.

### Debug Log References

- `pnpm check-migration-compatibility` — clean ("no destructive statements in any committed migration — OK").
- `make db-migrate` — migration `0057_organizations_default_locale` applied cleanly against a live Postgres instance (dev DB stack started via `docker compose up -d db`, ports fixed via `make fix-ports`).
- `make check-rls` — clean ("all org_id tables have RLS policies — OK"); `organizations` needs no new policy, per Dev Notes' RLS section.
- Full monorepo `pnpm turbo test --force` (17/17 tasks): `apps/api` 2380/2380, `apps/web` 1628/1628, `packages/db` 243/243, `packages/shared` 165/165, `api-contract-tests` 393/393, plus all other workspace packages green. No regressions.
- `apps/web` `pnpm run typecheck` (paraglide compile + `svelte-kit sync` + `tsc --noEmit`) clean; `pnpm run lint` clean (only pre-existing, unrelated warnings). `apps/api` `tsc --noEmit` and targeted `eslint` on all touched files clean (one pre-existing warning in `updateOrgDormancyColumn`, not from this story's code).

### Completion Notes List

- Ultimate context engine analysis completed — comprehensive developer guide created.
- All 5 tasks implemented via strict TDD (red confirmed for the expected reason before each green implementation), across `packages/db`, `apps/api`, `apps/web`.
- Task 1: added migration `0057_organizations_default_locale.sql` (verified against `_journal.json` at implementation time — `0057` was still free, no renumbering needed unlike Story 15.1's `0055→0056` collision) and the matching Drizzle schema column + named CHECK constraint on `packages/db/src/schema/organizations.ts`.
- Task 2: added `OrgDefaultLocaleSettingsBodySchema`/`ResponseSchema` and a third `PATCH /:orgId/default-locale-settings` route in `organization-settings-routes.ts`, with a dedicated `updateOrgDefaultLocaleColumn` handler (not a generalization of `updateOrgDormancyColumn`, per the story's own pre-elicitation decision) that reads the previous value before updating so the inline fail-closed audit write can report both `previousDefaultLocale`/`newDefaultLocale`. New test file `default-locale-settings-routes.test.ts` (13 tests) covers every AC 1/5/6/7 case including cross-org 404, `.strict()` tampering, rate-limit 429, and audit-fail-closed rollback.
- Task 3: `resolveRegistrationOrg` now returns `defaultLocale` for both the invitation branch (read from the existing org SELECT) and the self-signup branch (read back explicitly from the freshly-updated org row, never hardcoded a second time); threaded through `insertUserWithPlatformOperatorBootstrap`/`insertUserRow` into the `users` insert's `.values({...})`. `token-routes.ts`'s accept handler is untouched, confirmed by a new regression test asserting an existing user's locale survives accepting an invitation into an org with a different `default_locale`. Tests added to `apps/api/src/modules/invitations/routes.test.ts` (the file that already exercises both the invitation-register and invitation-accept flows) rather than a new file, covering AC2 (positive + "never configured" edge + self-signup-always-reads-its-own-org edge), AC3, and AC4 (including the OrgAdmin-changing-their-own-future-default edge).
- Task 4: added `updateOrgDefaultLocale` to the web `organization-settings.ts` client (same no-GET-readback disclosure comment pattern as its two siblings) and a new "Default language for new users" section on `/settings/users/+page.svelte`, gated by the page's existing `canManage` computation (no server-load changes). 3 new component tests added to `users-page.test.ts`.
- Task 5: `route-exemptions.ts`'s `ROUTE_ACTION_CLASSIFICATIONS` registry required a new entry for the route (`route-audit.test.ts`'s static scan enforces this) — added alongside the two existing dormancy-settings entries. All CI-equivalent checks (migration compatibility, RLS coverage, route-audit, full test suite, typecheck, lint) verified green.
- Judgment call: the story's Dev Notes suggested `apps/api/src/modules/auth/service.test.ts` as one option for the Task 3.4 tests, but that file only tests `slugify`/`isUniqueViolation` in isolation — there is no existing `registerUser` integration-test file in that module. Added the new registration/accept locale tests to `apps/api/src/modules/invitations/routes.test.ts` instead, since it already hosts the `POST /api/v1/auth/register with invitationToken` and `POST /api/v1/invitations/:token/accept` describe blocks these ACs are about, and already has the `inviteAndTokenize`/`registerWithToken`/`acceptInvitation` helpers needed — avoids duplicating that scaffolding in a new file.
- Judgment call: `default-locale-settings-routes.test.ts` was created as a new sibling file (matching the story's own suggested "or a new sibling test file matching this module's existing per-setting test file split" option in Task 2.6) rather than extending a single shared `organization-settings-routes.test.ts`, since no such combined file exists in this codebase — the existing precedent is one file per setting (`user-dormancy-settings-routes.test.ts`).

### Change Log

| Date | Change |
|------|--------|
| 2026-07-27 | Story implemented via bmad-dev-story: `organizations.default_locale` column (migration 0057), `PATCH /api/v1/organizations/:orgId/default-locale-settings` (role-gated, rate-limited, fail-closed-audited), registration-time locale seeding in `auth/service.ts`, and the Settings > Users web control. Status: ready-for-dev → in-progress (pick-story) → review (bmad-dev-story). |

### File List

- `packages/db/src/migrations/0057_organizations_default_locale.sql` (new)
- `packages/db/src/migrations/meta/_journal.json` (modified)
- `packages/db/src/schema/organizations.ts` (modified)
- `apps/api/src/modules/org/organization-settings-schema.ts` (modified)
- `apps/api/src/modules/org/organization-settings-routes.ts` (modified)
- `apps/api/src/modules/org/default-locale-settings-routes.test.ts` (new)
- `apps/api/src/lib/route-exemptions.ts` (modified)
- `apps/api/src/modules/auth/service.ts` (modified)
- `apps/api/src/modules/auth/platform-operator-bootstrap.test.ts` (modified)
- `apps/api/src/modules/invitations/routes.test.ts` (modified)
- `apps/web/src/lib/api/organization-settings.ts` (modified)
- `apps/web/src/lib/api/organization-settings.test.ts` (modified)
- `apps/web/src/routes/(app)/settings/users/+page.svelte` (modified)
- `apps/web/src/routes/(app)/settings/users/users-page.test.ts` (modified)
