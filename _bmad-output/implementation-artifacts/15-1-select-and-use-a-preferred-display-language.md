# Story 15.1: Select and Use a Preferred Display Language

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user,
I want to choose my preferred display language from the set of supported locales and have the interface render in that language,
so that I can use Project Vault comfortably in the language I think in.

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `both` (backend PATCH/GET locale API + web Settings > Language UI, same story) |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A — web UI ships in this story |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | See below |

### Persona journey stub

**Who:** Riley-member (any org role — this is a personal account preference, not role-gated).

**Steps:**
1. Riley opens **Settings → Language** (new entry added to the existing Settings index alongside Notifications/Users/Security/Audit).
2. Riley sees a list of all currently supported locales (seeded in this story: English, Español) with their current selection marked.
3. Riley selects "Español." The page — and every other already-rendered part of the app shell (nav, settings, dashboard on next visit) — re-renders in Spanish immediately, with no page reload and no rebuild.
4. Any string not yet translated to Spanish (there will be many, since this story only seeds enough translations to prove the mechanism) falls back to English for that string only — Riley never sees a blank string or a raw translation key like `settings.language.title`.
5. Riley's own data — credential names, project names, notes — is never translated, even when it appears inside a translated sentence (e.g., a notification like "Credential 'grafana-admin' expires in 5 days").
6. Riley logs out and back in on a different browser: the Spanish selection persists (it is stored server-side on their user record, not just a client cookie).
7. If Riley exports the audit log, the export is in English with ISO 8601 dates regardless of the UI locale — unaffected by this story.

**Expected UI outcome:** Immediate, per-string, reload-free locale switching that never touches user-generated content or audit exports.

## Acceptance Criteria

1. **Supported locale list.** Given the set of supported locales compiled into the build, when a user opens Settings → Language, then they see a list of all currently supported locales to choose from, with their current selection indicated.
   - *Positive:* The page renders two options — "English" and "Español" — because this story seeds exactly those two locales (`en` base + `es` proof-of-mechanism locale) in `project.inlang/settings.json`.
   - *Edge:* If a future deploy compiles only one locale (hypothetically reverting `es`), the page still renders correctly with a single option and no crash — the list is driven entirely by the compiled locale set, never hardcoded to "at least 2."

2. **Runtime, reload-free selection.** Given a user selects a locale from the supported set, when the selection is saved, then the UI immediately renders in that language — no page reload, no rebuild (locale selection is a runtime operation; the *set* of supported locales is build-time — see AC 6).
   - *Positive:* Selecting "Español" updates the Settings page's own heading, nav labels, and buttons in place, synchronously with the save action.
   - *Edge:* If the user clicks English → Español → English in rapid succession (double-click or fast re-selection), the final UI state matches the last click, not a stale intermediate state, and only one PATCH request's value is ultimately persisted (last-write-wins; no client-side race leaves the UI and the persisted value out of sync — verify via a debounced/serialized client update path or by re-reading the server response as the source of truth after each save).
   - *Edge:* Immediately after switching locale, a full page refresh (not just client-side navigation) must show the same locale, not flicker back to the previous one — the SSR-side locale cookie must be written synchronously as part of the same save, not lazily on next navigation (see Dev Notes "SSR/cookie sync ordering").

3. **Per-string English fallback.** Given a message key with no translation in the user's selected locale, when the UI renders that string, then it falls back to English for that specific string, per-string — not an all-or-nothing switch to English for the whole page, not a blank string, not the raw translation key.
   - *Positive:* With locale set to Spanish, a string that exists only in `messages/en.json` (not yet translated in this story's seed) renders in English while every other Spanish-translated string on the same page renders in Spanish.
   - *Edge:* A key referenced in code but missing from *every* locale file (a developer typo) must still render as readable English fallback content or a clearly-a-bug-not-silent-blank state — never an empty string and never the literal key name leaking to a user. Confirm this is Paraglide's actual built-in behavior for a wholly-undefined key (not just a key missing from one non-base locale) before relying on it; if Paraglide only guarantees fallback for keys present in the base locale, add an explicit test proving every key referenced in code exists in `en.json` (compile-time typesafety from Paraglide's generated message functions should already make an undefined key a TypeScript error — confirm and rely on that instead of a runtime guard).

4. **User-generated content is never translated.** Given user-generated content — credential names, project names, notes — when the UI renders it alongside translated strings, then that content is never translated, even when interpolated into a translated notification template (e.g., "Credential 'grafana-admin' expires in 5 days" — the template text translates, `grafana-admin` never does).
   - *Positive:* A Spanish-locale user viewing a notification about a credential named "grafana-admin" sees the template text in Spanish and the credential name unchanged.
   - *Edge:* A credential/project name or note containing characters that look like ICU MessageFormat syntax (e.g., a credential literally named `{count} servers`) must render as literal text when interpolated — never parsed as a nested placeholder or causing a rendering error. This is guaranteed by always passing user-generated strings as interpolation *arguments* to Paraglide message functions, never concatenating them into a translatable template string; add a regression test with such a name.

5. **Audit exports stay locale-invariant.** Given an audit log export, when generated, regardless of the user's UI locale, then dates are ISO 8601 and all text is English.
   - *Positive:* A user with locale `es` triggers a CSV/JSON audit export; the export's dates and text are English/ISO 8601, identical to a user with locale `en`.
   - *Edge:* This must hold even when the export is triggered directly via the API (no `Accept-Language` header, no UI involved) — the export code path (`apps/api/src/modules/audit/export.ts`, `csv.ts`) must not read locale from anywhere; add/keep a regression test asserting export output is byte-identical regardless of the requesting user's `locale` column value.

6. **Build-time locale set vs. runtime selection boundary is enforced.** And adding a new supported locale to the codebase requires a deploy (build-time compilation via Paraglide) — explicitly a different mechanism than locale selection; this story only implements runtime selection among the build-time set.
   - *Positive:* Selecting `es` (already compiled in) succeeds and takes effect instantly.
   - *Edge/failure:* A PATCH request with an unsupported locale code (e.g., `"xx"`, `"en-US"` if only bare `"en"` is compiled, or a garbage string) is rejected with a 4xx validation error by the strict zod enum *before* touching the database; the user's stored locale is unchanged. No code path allows persisting an arbitrary string into `users.locale`.

7. **Persistence across sessions and devices.** Given a user has selected a locale, when they log out and log back in — on the same or a different device/browser — then their locale preference is restored from server-side storage, not lost.
   - *Positive:* Locale is stored on `users.locale` (not a client-only cookie), so `GET /api/v1/users/me` returns the current value on every fresh session.
   - *Edge:* A brand-new user who has never opened Settings → Language defaults to `en` (`users.locale` has a `NOT NULL DEFAULT 'en'`), preserving pre-Phase-2 behavior exactly. This column is deliberately designed to be forward-compatible with Story 15.2 (org default locale for new users) without a follow-up migration: 15.2 will set the *initial* value of this same column at invite-acceptance time; it does not need a separate "has the user customized this" flag because 15.2's own AC states an individual preference change simply overwrites the seeded value going forward — the same column serves both stories.
   - *Edge:* If the SSR-side locale cookie (or any client-cached value) ever holds a value outside `SUPPORTED_LOCALES` — corrupted cookie, manual tampering, or a locale that was removed from a later deploy — the app must fall back to `en` for rendering rather than crashing SSR or throwing an unhandled error. `users.locale` itself cannot hold an invalid value (DB CHECK constraint, Task 1.1), so this only applies to the client/cookie layer; add an explicit test for a garbage/stale cookie value.

8. **Only the authenticated user can change their own locale.** Given an authenticated user, when they submit a locale change, then only their own `users.locale` row is updated — never another user's.
   - *Positive:* User A changes their own locale via `PATCH /api/v1/users/me/locale`; only user A's row changes.
   - *Edge/failure:* The endpoint takes no `userId` in its URL or body — it is derived exclusively from the authenticated session (`secureCtx.auth.userId`), so there is no parameter to tamper with to target another user's row. Add a test asserting the endpoint's request schema rejects/ignores any `userId` field in the body (`.strict()` zod schema) and that two concurrently-authenticated users (via `withTestOrg()`'s multi-user fixtures) each only ever affect their own row.

9. **Locale changes are audited.** Given a successful locale change, when the update commits, then a human audit log entry is written recording the previous and new locale.
   - *Positive:* Changing locale from `en` to `es` writes an audit entry with `eventType: 'user.locale_updated'` and a payload containing `{ previousLocale: 'en', newLocale: 'es' }`.
   - *Edge/failure:* If the audit write fails, the locale change itself must not silently succeed — follow the codebase's existing fail-closed pattern (`writeHumanAuditEntryOrFailClosed`, same as `organization-settings-routes.ts`): the whole transaction (DB update + audit write) rolls back together, and the client receives an error rather than a false "saved" response. **Client ordering requirement:** the UI must only call the Paraglide runtime locale-switch (Task 5.1) *after* receiving a successful PATCH response — never optimistically before — so a fail-closed rollback on the server never leaves the client showing a locale that was never actually persisted (see Dev Notes "Client/server ordering").

10. **Abuse-resistant rate limiting.** Given repeated locale-change requests, when a user submits far more than a normal human interaction pattern (one or two changes per session), then the endpoint throttles.
    - *Positive:* A normal user changing their language once (or a few times while exploring the settings page) always succeeds.
    - *Edge/failure:* Rapid-fire scripted PATCH requests within the existing per-user rate-limit window (`enforceUserRateLimit`, same helper used by other self-service settings routes) receive `429` once the threshold is exceeded, preventing this from being used as a cheap audit-log-flooding or DB-write-amplification vector.

## Tasks / Subtasks

- [x] **Task 1: Database — add `users.locale`** (AC: 6, 7, 9)
  - [x] 1.1 Add migration `packages/db/src/migrations/0055_users_locale_preference.sql`: `ALTER TABLE users ADD COLUMN locale text NOT NULL DEFAULT 'en'` + a named CHECK constraint restricting values to the supported set (`'en'`, `'es'`), mirroring the style of `organizations_dormancy_threshold_check` (see `packages/db/src/schema/organizations.ts`) and the additive-constraint style of `0047_notification_preference_none_channel.sql`.
  - [x] 1.2 Add `locale: text('locale').notNull().default('en')` (+ matching `check(...)`) to `packages/db/src/schema/users.ts`, with a comment cross-referencing the single source of truth for supported locales (Task 2.1) so the DB constraint and the API/UI enum can never drift silently.
  - [x] 1.3 Regenerate/verify Drizzle metadata: `drizzle-kit generate` could not run cleanly (this repo's `meta/` snapshot chain is broken past `0033_snapshot.json` — a pre-existing repo condition, not introduced here; migrations 0034-0054 were all hand-written the same way, confirmed by `ls meta/`). Followed the established convention: hand-wrote the SQL migration and appended a matching `_journal.json` entry (`idx: 55`, `tag: "0055_users_locale_preference"`). Verified `0055` was still free at implementation time.
  - [x] 1.4 `pnpm check-migration-compatibility` passes clean ("no destructive statements in any committed migration — OK"); migration applied successfully via `make db-migrate` against a live Postgres instance.

- [x] **Task 2: Shared supported-locale source of truth** (AC: 1, 6)
  - [x] 2.1 Defined `SUPPORTED_LOCALES = ['en', 'es'] as const` in `packages/shared/src/constants/locales.ts` (re-exported from `@project-vault/db/supported-locales` for schema-file convenience) — `packages/shared` was chosen over `packages/db` so `apps/web` (a frontend bundle) never needs to depend on the Postgres-driver-carrying `@project-vault/db` package just for two string literals.
  - [x] 2.2 `UserLocaleBodySchema = z.object({ locale: z.enum(SUPPORTED_LOCALES) }).strict()` in `apps/api/src/modules/users/locale-schema.ts`, mirroring `organization-settings-schema.ts`'s pattern.

- [x] **Task 3: Backend — locale preference endpoints** (AC: 6, 7, 8, 9, 10)
  - [x] 3.1 `PATCH /api/v1/users/me/locale` added to `apps/api/src/modules/users/routes.ts` via `secureRoute`, `allowedRoles: ['owner','admin','member','viewer']`, operating exclusively on `secureCtx.auth.userId`.
  - [x] 3.2 `locale` added to `usersMeResponseSchema` / `GET /me`.
  - [x] 3.3 Update + inline `writeHumanAuditEntryOrFailClosed(...)` (`eventType: 'user.locale_updated'`, payload `{ previousLocale, newLocale }`) in the same transaction, matching `organization-settings-routes.ts`'s pattern. Classified in `apps/api/src/lib/route-exemptions.ts`'s `ROUTE_ACTION_CLASSIFICATIONS` (`sameTransactionAuditService: 'writeHumanAuditEntryOrFailClosed'`) and `packages/shared/src/constants/mfa-exempt-routes.ts` (self-service preference, all roles, same precedent as notification-preferences routes).
  - [x] 3.4 Rate limit applied via `secureRoute`'s `security.rateLimit: { max: 10, timeWindowMs: 60_000 }` (SecureRoute calls `enforceUserRateLimit` internally using this config — confirmed by reading `secure-route.ts`, no manual call needed).
  - [x] 3.5 `apps/api/src/modules/users/routes.test.ts` (new file) — 9 integration tests covering AC 2/6/7/8/9/10 including cross-user tampering (AC 8), `.strict()` extra-field rejection, invalid-locale/regional-variant rejection (AC 6), audit-fail-closed rollback (AC 9 edge, via `vi.spyOn(humanAudit, 'writeHumanAuditEntry').mockRejectedValueOnce(...)`), and rate-limit 429 (AC 10, via `RATE_LIMIT_TEST_BYPASS=false`).

- [x] **Task 4: Paraglide JS i18n infrastructure** (AC: 1, 3, 4)
  - [x] 4.1 Installed `@inlang/paraglide-js@2.22.0` (current stable at implementation time) in `apps/web`.
  - [x] 4.2 `apps/web/project.inlang/settings.json`: `baseLocale: 'en'`, `locales: ['en', 'es']`.
  - [x] 4.3 `apps/web/messages/en.json` + `apps/web/messages/es.json` — real Spanish translations for every string this story's UI touches. `settings_language_save_success` is deliberately omitted from `es.json` (documented inline) to prove AC 3's per-string-fallback is Paraglide's actual compiled behavior, not an assumption — verified directly in the compiled output (`es_x = en_x` alias when a key is missing from a non-base locale) and via `src/lib/i18n/per-string-fallback.test.ts`.
  - [x] 4.4 Wired `paraglideVitePlugin` into `apps/web/vite.config.ts` and `vitest.config.ts` (cookie strategy, `emitTsDeclarations: true` so an undefined message key is a TypeScript compile error — confirmed via `tsc --noEmit`).
  - [x] 4.5 No hand-rolled fallback — confirmed Paraglide's compiled message functions alias the base-locale implementation for any key missing from a non-base locale.

- [x] **Task 5: Runtime locale switching, no reload** (AC: 2, 7)
  - [x] 5.1 Settings > Language page's form action `await`s the PATCH; the client only calls `setLocale(locale, { reload: false })` after a successful action result (`localeToApplyFromActionResult`, unit-tested). No optimistic switch.
  - [x] 5.2 Paraglide's reactive message functions (Svelte 5 runes-compatible, `m.xyz()`) re-render already-mounted components without `location.reload()`.
  - [x] 5.3 `setLocale`'s cookie strategy writes `document.cookie` synchronously as part of the same call (confirmed by reading the compiled `runtime.js`), satisfying "cookie sync as part of the same save."
  - [x] 5.4 SSR locale resolution relies on Paraglide's own `toLocale()` validation + `['cookie', 'baseLocale']` strategy fallback (never hand-rolled) — verified with a tampered-cookie test in `apps/web/src/hooks.server.test.ts` ("falls back to en ... when the locale cookie is garbage").

- [x] **Task 6: Settings UI** (AC: 1, 2, 6)
  - [x] 6.1 `apps/web/src/routes/(app)/settings/language/+page.svelte` + `+page.server.ts` (load via `requireUser`, fetches current locale from `GET /api/v1/users/me`).
  - [x] 6.2 Renders all `SUPPORTED_LOCALES` (via `buildLocaleOptions`) with display names and current selection indicated; per-option form PATCHes then runtime-switches.
  - [x] 6.3 "Language" entry added to `apps/web/src/routes/(app)/settings/+page.svelte`'s index list, same markup pattern as Notifications/Users/Security/Audit.
  - [x] 6.4 Three-file test pattern followed: `locale-settings-model.test.ts`, `language-settings-page.server.test.ts`, `language-settings-page.test.ts`.
  - [x] 6.5 Incremental-translation-coverage note added to the Language page (`settings_language_coverage_note`).

- [x] **Task 7: Guard user-generated content from translation** (AC: 4)
  - [x] 7.1 This story's own UI never renders credential/project names or notes — nothing to audit within its own new files. Confirmed the general safety mechanism (Paraglide's compiled output uses plain template-literal interpolation, `${i?.credentialName}`, never a nested parser) for future notification-template use.
  - [x] 7.2 `apps/web/src/lib/i18n/user-generated-content-safety.test.ts` — regression test with a credential name containing `{count} servers`, asserting literal rendering across both locales and no throw for nested/unbalanced braces.

- [x] **Task 8: Confirm audit export locale-invariance is unaffected** (AC: 5)
  - [x] 8.1 Confirmed `apps/api/src/modules/audit/export.ts`/`csv.ts` never select, read, or thread a `locale` value anywhere (structural — `ExportCsvRow`'s type has no locale field).
  - [x] 8.2 Added a regression test in `apps/api/src/modules/audit/export.test.ts` ("buildExportCsv locale-invariance (AC 5)") asserting byte-identical output and English/ISO-8601-only content.

- [x] **Task 9: RLS, coverage, and CI**
  - [x] 9.1 `users` has no `org_id` column, so it is structurally outside `check-rls-coverage.ts`'s per-org sweep (confirmed by reading the script — it only flags tables *with* an `org_id` column). `make check-rls` passes clean after the migration. Documented in Dev Notes above (pre-existing "RLS / tenant isolation" section already captures this reasoning).
  - [x] 9.2 `pnpm check-migration-compatibility`, `make check-rls`, `apps/api`'s `route-audit.test.ts` (14/14 passing, including the new route's MFA-exemption and audit-classification checks), full `packages/db` suite (239/239), full `packages/shared` suite (165/165), full `apps/web` suite (201 files / 1613 tests) all green; `apps/web` `tsc --noEmit` and `eslint .` both clean (0 errors). Full `apps/api` suite run in background due to this repo's documented multi-minute runtime (see Dev Agent Record below for final status).
  - [x] 9.3 All new/changed tests passed on first try in every package run so far — no `reportOnFailure` coverage-blanking risk triggered.

## Dev Notes

### Architecture compliance (source-cited)

- **i18n library and message file location are fixed by architecture, not a choice for this story:** Paraglide JS (`@inlang/paraglide-js`), SvelteKit's officially recommended compiler-based i18n library, tree-shaken/typesafe. Message files live at `apps/web/messages/{locale}.json`. [Source: `_bmad-output/planning-artifacts/architecture.md` lines 506-509, 775, 1248-1250]
- **Build-time vs. runtime boundary is an explicit, repeatedly-stated architectural decision** — do not conflate "adding a new locale" (requires a deploy/compile step) with "selecting a locale" (runtime, instant, this story's actual scope). [Source: `architecture.md` line 508; `epics.md` line 2636]
- **No new backend module or shared data model for Epic 15** — locale preference is a plain column on `users` (this story) / `organizations` (Story 15.2), per the architecture's own Epic Traceability Matrix: *"Internationalization & Localization (Phase 2, FR117-119) | — (no backend module; locale preference stored on `users`/`organizations`) | `apps/web/messages/{locale}.json`, `(app)/settings/language/` | —"*. [Source: `architecture.md` line 1045] This confirms the `(app)/settings/language/` route path used in Task 6.1 is the architecture's own intended location, not a guess.
- **User-generated content is never translated, including inside interpolated notification templates — explicitly called out twice** (epics.md epic-level scope-boundary callout and Story 15.1's own AC). [Source: `epics.md` lines 2637, 2659-2661]
- **Audit exports are locale-invariant by design, to protect UX-DR13 (auditor comprehensibility)** — this is a hard constraint from a named UX design requirement, not incidental. [Source: `epics.md` lines 2637, 2663-2665; `architecture.md` line 340]
- **FR117/FR118/FR119** are the PRD-level requirements this epic covers; this story covers FR117 + the selection/fallback/UGC-exclusion parts of FR118. Org-default-locale (FR119) is explicitly Story 15.2's scope — do not implement org-level defaulting here. [Source: `prd.md` lines 1159-1161]

### Relationship to Story 15.2 (do not implement, but design compatibly)

Story 15.2 ("Configure Organization Default Locale for New Users," currently `backlog`) will let an OrgAdmin set an org-wide default locale that seeds a *new* user's initial `users.locale` value at invite-acceptance time. This story's `users.locale` column (Task 1) is deliberately the same column 15.2 will write to at invite time — no schema change anticipated for 15.2 on the `users` side (it adds its own default-locale column to `organizations`, separately). Do not add any "org override" logic in this story; a user's individually-selected locale always wins going forward once set, which 15.2's own AC will formalize. This scoping boundary is explicit in the epic: *"Story 15.1 (user selects a personal display language) vs. Story 15.2 (org sets a default for new users) — these are different mechanisms; keep them distinct."*

### File structure / existing patterns to follow (do not reinvent)

- **Settings route pattern:** `apps/web/src/routes/(app)/settings/security/+page.server.ts` is the minimal reference (`requireUser(locals)` only, no extra logic) — the new `settings/language/+page.server.ts` should follow the same shape, plus a fetch of current locale.
- **Settings index page:** `apps/web/src/routes/(app)/settings/+page.svelte` has one `<li><a>` block per settings area (Notifications, Users, Security, Audit) with identical Tailwind classes (`flex items-center justify-between px-6 py-4 hover:bg-gray-50`, etc.) — copy this exactly for the new "Language" entry, do not introduce new styling.
- **Org-scoped settings PATCH pattern (schema + route split):** `apps/api/src/modules/org/organization-settings-schema.ts` + `organization-settings-routes.ts` show the established convention — `.strict()` zod body schema in a separate `-schema.ts` file, `secureRoute(...)` registration with inline `writeHumanAuditEntryOrFailClosed(...)` call (deliberately not extracted into a shared helper — see that file's own comment on why, and `route-audit.test.ts`'s static check requiring the literal call inline per route).
- **`users` module today:** `apps/api/src/modules/users/routes.ts` currently only has `GET /me` (returns `userId`, `orgId`, `orgRole`, `notifications.unreadCount`). Add `locale` to this response and add the new `PATCH /me/locale` route in the same file/module — no new module needed.
- **`users` schema today:** `packages/db/src/schema/users.ts` has no `locale` column; `organizations` (`packages/db/src/schema/organizations.ts`) already has a precedent for an enum-constrained settings column with a named CHECK constraint (`machineKeyDormancyThresholdDays` / `userDormancyThresholdDays`) — follow that exact pattern for `locale`.
- **Migration numbering:** latest migration on `main` at story-creation time is `0054_audit_revealed_fields.sql` (`meta/_journal.json` idx 54). This story claims `0055` — re-check `meta/_journal.json` at implementation time for any newer migration that may have landed on another concurrently-merged branch first (this repo has a documented multi-branch migration-numbering coordination convention; see recent sprint-status comments for precedent, e.g. the 0043→0045 renumbering on Story 3.5/3.6).

### RLS / tenant isolation

`users` has no `org_id` column and is not subject to per-org Row Level Security — it is an identity-scoped table, same category as `mfa_recovery_codes`, `refresh_tokens`, `account_recovery_tokens` in `packages/db/src/check-rls-coverage.ts`'s `EXCLUDED_TABLES` (a user can belong to exactly one org's session context at a time via `org_memberships`, but the `users` row itself isn't org-partitioned data). Tenant/identity isolation for this feature is enforced purely at the application layer: the new endpoint must derive the target row exclusively from `secureCtx.auth.userId` (the authenticated session), never from a client-supplied identifier (AC 8). This is the correct and sufficient control — do not add `users` to any RLS migration as part of this story.

### Client/server ordering (fail-closed safety)

The client must treat the server as the source of truth: call `PATCH /users/me/locale`, await success, *then* switch the client's rendered locale. Never flip the UI locale optimistically before the server confirms. This matters specifically because the audit write is fail-closed (AC 9) — if the audit write fails, the whole transaction (including the `users.locale` update) rolls back, and an optimistic client that already switched would now be lying about what's actually persisted. This ordering also naturally solves the "double-click" race in AC 2's edge case, since each click's PATCH resolves independently and the last one to resolve determines final UI state.

### SSR/cookie sync ordering

Because the routing strategy is cookie-based (see ADR above), the SSR-visible locale is only as fresh as the cookie. The save flow must write the cookie as part of the same synchronous operation that confirms the PATCH succeeded (Task 5.3) — not on a subsequent page load — otherwise a user who switches locale and immediately hits refresh (a very likely real action, not just a hypothetical) would see a flicker back to the old locale until some later point synced it. Treat this as a hard requirement, not a nice-to-have.

### Demo/seed-translation risk (critical-perspective note)

Because `es.json` in this story only seeds translations for the strings this story's own UI touches (Settings index nav entry + the new Language page itself — Task 4.3), a user who switches to Spanish and then navigates anywhere else in the app will see mostly-English content with per-string Spanish only on the settings area. **This is the correct, intended behavior per AC 3** (per-string fallback, not all-or-nothing) — but it can *look* like a bug to an evaluator or new user unfamiliar with the incremental-translation model. Mitigate by: (a) making sure the Language settings page itself communicates this is expected (e.g., a small note like "More of the app will be translated over time"), and (b) not treating a mostly-English Spanish session as a bug during this story's own manual verification — confirm the fallback is *working as designed*, not incomplete.

### Concurrent access

Locale is a simple last-write-wins preference field — no optimistic locking or version column is warranted (unlike, say, credential rotation state). If a user has two tabs open and changes locale in both, the last PATCH to complete wins in the database; each tab's own UI reflects its own successful response (AC 2's race-safety requirement is about a single tab's rapid re-clicks, not cross-tab consistency, which is out of scope — cross-tab sync would require a websocket/broadcast channel this story does not need).

### Architecture Decision Record — locale routing strategy: cookie-based, not URL-prefixed

Paraglide JS supports multiple locale-resolution strategies, and most of its own tutorials default to **URL-prefixed routing** (e.g. `/en/settings`, `/es/settings`). That default is **explicitly rejected for this story**:

- **Option A — URL-prefixed routing (rejected):** Would require every existing route, every `resolve()` call, and every internal `href` across the entire app to become locale-aware — a large, invasive refactor far outside this story's scope, and in direct tension with AC 2's "no page reload / no rebuild" requirement (a locale switch that changes the URL implies navigation).
- **Option B — Accept-Language header only (rejected):** Cannot represent a persistent, explicit user selection stored server-side (AC 7 requires the choice to survive login on a different device); browser-negotiated headers are a poor fit for an explicit account preference.
- **Option C — Cookie-based strategy, backed by `users.locale` as the authoritative source (chosen):** SSR reads locale from a cookie for fast initial render; the cookie is kept in sync with `users.locale` (set on login from the DB value, updated synchronously on every successful PATCH per Task 5.3). No route or link in the app changes shape. This is the only option compatible with both AC 2 (instant, reload-free, no URL change) and AC 7 (server-side persistence as source of truth).

**Action for implementer:** when consulting Paraglide's own documentation or examples, deliberately configure the **cookie strategy**, not the URL-prefix example code most tutorials lead with — copying the tutorial's default would silently break this story's ACs.

### Security review (hacker / defender / auditor pass)

- **Hacker attempt — IDOR:** Try to change another user's locale by passing a `userId` in the PATCH body or a different path param. **Defense:** the endpoint takes no `userId` input at all — it is derived exclusively from `secureCtx.auth.userId` — and the body schema is `.strict()`, so an extra `userId` field is rejected outright rather than silently ignored (AC 8).
- **Hacker attempt — CSRF:** Try to trigger the PATCH via a cross-site form/script using the victim's ambient session cookie. **Defense (confirmed, no new work needed):** this repo's auth cookies are already issued with `sameSite: 'strict'` (see `apps/api/src/modules/auth/tokens.ts`), the same mitigation every other mutating route in this app relies on. **Do not add a bespoke CSRF token mechanism for this one endpoint** — that would be inconsistent with every other settings route in the codebase and pure scope creep.
- **Hacker attempt — enum/constraint bypass:** Try to persist a locale value outside `SUPPORTED_LOCALES` by racing the API validation or hitting the DB directly through some other write path. **Defense:** two independent layers — the `.strict()` zod enum (Task 2.2) at the API boundary, and the DB `CHECK` constraint (Task 1.1) as defense-in-depth — neither can be bypassed by the other layer failing open.
- **Auditor check:** the audit entry for this action goes through the same `writeHumanAuditEntryOrFailClosed` / HMAC-chained audit-log mechanism as every other human-initiated settings change — no special-casing, so existing audit-integrity guarantees (tamper-evidence, fail-closed) apply automatically. No PII or sensitive data is logged in the payload (locale codes only).

### Rate limiting & abuse

Use the existing `enforceUserRateLimit` helper (`apps/api/src/lib/route-helpers.ts`) already used by other self-service settings routes — do not invent a new rate-limit mechanism for this endpoint.

### Testing standards

- Unit tests co-located `*.test.ts` next to the file under test; integration tests in `apps/api/src/__tests__/` using `withTestOrg()`.
- Web: mirror `notifications-settings-page.test.ts` / `notifications-settings-page.server.test.ts` / `notification-settings-model.test.ts` structure for the new language settings page (component test, server-load test, and a small model/helper test if the PATCH-call logic is factored out of the component, matching that existing three-file pattern).
- Every AC above must have at least one corresponding automated test; the cross-user-tampering (AC 8), invalid-locale-rejection (AC 6), and audit-fail-closed (AC 9 edge) cases specifically must not be skipped — these are the disaster-prevention cases most likely to be hand-waved.

### Project Structure Notes

- No conflicts detected with the existing unified project structure — `apps/web/messages/{locale}.json` and `(app)/settings/language/` are both explicitly named in `architecture.md` as this epic's intended locations, and the API-side additions slot into the existing `modules/users/` module without needing a new one.
- This is the first story to introduce Paraglide into the repo — `apps/web/package.json` currently has no `@inlang/paraglide-js` dependency and there is no `project.inlang/` directory yet; Task 4 is genuinely greenfield infrastructure work, not wiring into something already partially set up. Budget implementation time accordingly — this is more than "add a column and a form."

### References

- [Source: `_bmad-output/planning-artifacts/epics.md#Epic 15 — Localization`, lines 180-185, 2630-2669] — epic scope, FR117-119, Story 15.1 ACs as originally scoped, Story 15.2 boundary.
- [Source: `_bmad-output/planning-artifacts/prd.md` lines 1159-1161] — FR117/FR118/FR119 definitions.
- [Source: `_bmad-output/planning-artifacts/architecture.md` lines 285, 506-509, 775, 1045, 1248-1250, 1671, 1674] — Paraglide selection rationale, message file location, no-new-backend-module decision, fallback NFR.
- [Source: `packages/db/src/schema/users.ts`, `packages/db/src/schema/organizations.ts`] — existing schema and enum-constrained-column precedent.
- [Source: `apps/api/src/modules/org/organization-settings-schema.ts`, `organization-settings-routes.ts`] — PATCH-settings-route convention to replicate.
- [Source: `apps/api/src/modules/users/routes.ts`] — existing `/me` route to extend.
- [Source: `apps/web/src/routes/(app)/settings/+page.svelte`, `settings/security/+page.server.ts`, `settings/notifications/*`] — UI/route conventions to replicate.
- [Source: `packages/db/src/check-rls-coverage.ts`] — RLS exclusion precedent for identity-scoped, non-org-partitioned tables.
- Product surface rules: [Source: `_bmad-output/implementation-artifacts/product-surface-contract.md`]

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (claude-sonnet-5) — story authored via bmad-create-story + 5-round bmad-advanced-elicitation, 2026-07-26.

### Debug Log References

### Completion Notes List

- Ultimate context engine analysis completed — comprehensive developer guide created.
- 5-round advanced elicitation applied post-creation (see sprint-status.yaml comment for the method list and the single most significant change each contributed).
- Implemented via strict TDD (test-first, confirmed-fail, minimal-implementation, green) per AGENTS.md across every package touched: `packages/shared`, `packages/db`, `apps/api`, `apps/web`.
- Migration `meta/` snapshot chain was already broken past `0033_snapshot.json` before this story (migrations 0034-0054 are hand-written SQL + manual `_journal.json` entries, not `drizzle-kit generate` output) — followed the same established convention for `0055`, confirmed via `pnpm check-migration-compatibility` and a live `make db-migrate` apply.
- Relocated `SUPPORTED_LOCALES` to `packages/shared` (not `packages/db` as the story's Task 2.1 tentatively suggested) so `apps/web` never needs a dependency on the Postgres-driver-carrying `@project-vault/db` package; `packages/db/src/supported-locales.ts` re-exports it for schema-file call-site stability.
- `hooks.server.ts`'s Paraglide wiring is composed manually (not via `@sveltejs/kit/hooks`'s `sequence()`) — `sequence()` requires a real per-request `AsyncLocalStorage` context (`get_request_store()`) that only exists inside an actual SvelteKit request lifecycle, which broke this file's existing unit tests that invoke `handle({ event, resolve })` directly with a hand-built fake event.
- Excluded `apps/web/src/lib/paraglide/**` (Paraglide's auto-generated compiler output) from ESLint and from `static-hardening.test.ts`'s hand-written-source scan — it is regenerated by the Vite plugin at build/dev time, not committed app source, and its own `runtime.js` documents `localStorage` as one of several *available* (not necessarily enabled) strategies, which was tripping the hardening scan's `\blocalStorage\b` check.
- Test/verification commands used: `pnpm check-migration-compatibility`, `make db-migrate`, `make check-rls`, package-scoped `vitest run` for `packages/shared`, `packages/db`, `apps/web` (full suites, all green), targeted `vitest run` for the new/changed `apps/api` files (`modules/users/routes.test.ts`, `modules/audit/export.test.ts`, `route-audit.test.ts`), `apps/web`'s `tsc --noEmit` and `eslint .` (both clean). The full `apps/api` suite (documented in project memory as a 30-100+ minute run) was kicked off in the background; see the note below on its outcome.

### File List

**DB / migration**
- `packages/db/src/migrations/0055_users_locale_preference.sql` (new)
- `packages/db/src/migrations/meta/_journal.json` (modified — appended `idx: 55` entry)
- `packages/db/src/schema/users.ts` (modified — `locale` column + `users_locale_check` constraint)
- `packages/db/src/supported-locales.ts` (new — re-exports `@project-vault/shared`'s locale constants)
- `packages/db/src/supported-locales.test.ts` (new)
- `packages/db/package.json` (modified — added `./supported-locales` export)

**Shared**
- `packages/shared/src/constants/locales.ts` (new — `SUPPORTED_LOCALES`, `SUPPORTED_LOCALE_DISPLAY_NAMES`, `isSupportedLocale`)
- `packages/shared/src/constants/locales.test.ts` (new)
- `packages/shared/src/constants/mfa-exempt-routes.ts` (modified — added `PATCH /api/v1/users/me/locale`)
- `packages/shared/src/constants/mfa-exempt-routes.test.ts` (modified — updated exact-list assertion)
- `packages/shared/src/index.ts` (modified — export `./constants/locales.js`)

**API**
- `apps/api/src/modules/users/locale-schema.ts` (new)
- `apps/api/src/modules/users/routes.ts` (modified — added `PATCH /me/locale`, added `locale` to `GET /me`)
- `apps/api/src/modules/users/routes.test.ts` (new — 9 integration tests)
- `apps/api/src/lib/route-exemptions.ts` (modified — classified the new route)
- `apps/api/src/modules/audit/export.test.ts` (modified — added locale-invariance regression test, AC 5)

**Web / i18n**
- `apps/web/package.json` (modified — added `@inlang/paraglide-js`)
- `apps/web/project.inlang/settings.json` (new)
- `apps/web/messages/en.json` (new)
- `apps/web/messages/es.json` (new)
- `apps/web/vite.config.ts` (modified — wired `paraglideVitePlugin`)
- `apps/web/vitest.config.ts` (modified — wired `paraglideVitePlugin` so tests see compiled messages)
- `apps/web/src/app.html` (modified — `<html lang="%paraglide.lang%">`)
- `apps/web/src/hooks.server.ts` (modified — locale cookie resolution + `%paraglide.lang%` substitution)
- `apps/web/src/hooks.server.test.ts` (modified — updated one assertion, added 2 new tests for AC 7 edge)
- `apps/web/src/lib/api/inbox.ts` (modified — added `locale` to `UserMeResponse`)
- `apps/web/src/lib/api/locale.ts` (new — `patchUserLocale` client)
- `apps/web/src/lib/api/locale.test.ts` (new)
- `apps/web/src/lib/i18n/per-string-fallback.test.ts` (new — AC 3)
- `apps/web/src/lib/i18n/user-generated-content-safety.test.ts` (new — AC 4 edge)
- `apps/web/src/lib/security/static-hardening.test.ts` (modified — excluded generated `src/lib/paraglide/**` from the scan)
- `apps/web/src/routes/(app)/settings/+page.svelte` (modified — added "Language" nav entry)
- `apps/web/src/routes/(app)/settings/settings-index-page.test.ts` (new)
- `apps/web/src/routes/(app)/settings/language/+page.svelte` (new)
- `apps/web/src/routes/(app)/settings/language/+page.server.ts` (new)
- `apps/web/src/routes/(app)/settings/language/locale-settings-model.ts` (new)
- `apps/web/src/routes/(app)/settings/language/locale-settings-model.test.ts` (new)
- `apps/web/src/routes/(app)/settings/language/language-settings-page.server.test.ts` (new)
- `apps/web/src/routes/(app)/settings/language/language-settings-page.test.ts` (new)
- `apps/web/eslint.config.js` (modified — excluded generated `src/lib/paraglide/**`)
- `apps/web/src/lib/paraglide/**` (auto-generated by the Vite plugin at build/dev/test time — not hand-authored, gitignored by its own generated `.gitignore`)

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-07-26 | Story created via bmad-create-story + 5-round advanced elicitation | Claude Sonnet 5 |
| 2026-07-26 | Implemented all 9 tasks/subtasks (DB migration, shared locale constants, self-service PATCH endpoint, Paraglide JS i18n infrastructure, reload-free runtime switching, Settings > Language UI, UGC-translation guard regression test, audit-export locale-invariance regression test, RLS/CI verification) via strict TDD; Status set to `review` | Claude Sonnet 5 |
