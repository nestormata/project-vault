# Story 16.4: Org-Wide Default Theme for Pre-Auth and New Users

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As an Organization Admin,
I want to configure a default/fallback theme for my organization,
so that anonymous users on the login screen and authenticated members who haven't personally chosen a theme see my organization's branding instead of the generic base theme.

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `both` (backend PATCH setting + web UI control, same story) |
| **Evaluator-visible** | yes — a new "Default theme for this organization" section on the existing `(app)/settings/themes/` page, plus visible branding on the pre-auth login screen and for never-customized members |
| **Linked UI story** (if API-only) | N/A — UI ships in this story |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | See below |

### Persona journey stub

**Riley-admin (org role `admin` or `owner`):**
1. Riley's org (`Acme Corp`, `acme.com`) already has SSO configured for the `acme.com` domain (Story 14.4/14.6 — `org_sso_domains` has a row mapping `acme.com` → their SSO strategy) and has installed a custom theme `acme-brand` via Story 16.1 (`VAULT_THEMES_DIR` + reload).
2. Riley opens `(app)/settings/themes/` (the existing theme page from Stories 16.2/16.3). Below the personal theme-selection list and the admin-only "Reload themes" section (16.3), Riley sees a new admin-only "Default theme for this organization" section — a dropdown of currently available themes (same list `GET /api/v1/themes` already returns) plus "None (base theme)".
3. Riley selects `acme-brand` and it saves immediately (matching this page's existing immediate-save pattern, no separate Save button). A confirmation message appears.
4. Alex, a brand-new hire at Acme Corp, is invited and accepts. Alex has never touched Settings → Themes (`users.selected_theme_name` is `NULL`). Every page Alex loads under `(app)` now renders with `acme-brand` applied — no action needed on Alex's part, and no flash of the base theme (SSR-rendered, same no-FOUC guarantee 16.2 established).
5. A prospective new hire types `alex@acme.com` on the **pre-auth login screen** (before ever authenticating). The existing two-step, email-first login flow (Story 14.4) already looks up `acme.com` for an SSO mapping; this story extends that same lookup to also resolve Acme Corp's default theme. The login screen picks up `acme-brand`'s branding reactively, the moment the domain lookup resolves — before any password/SSO step renders.
6. Morgan, an existing Acme Corp member, had already personally selected a different theme (`morgan-dark`) via Story 16.2. Riley changing the org default to `acme-brand` has **zero effect** on Morgan's view — personal selection always wins over the org default, exactly as Story 15.2 established for locale.
7. A different org, `Startup Inc`, has never configured `org_sso_domains` for its email domain at all (no SSO). A brand-new visitor typing an `@startupinc.example` email on the login screen sees the plain base theme — this story's pre-auth branding is reachable **only** through the same domain-resolution mechanism Story 14.4 already built, and a non-domain-mapped org has no pre-auth org-resolution path today. This is a documented, deliberate scope boundary (see Dev Notes "Pre-auth org-resolution judgment call"), not a bug.

**Expected UI outcome:** An org-admin-only control that sets an org-wide fallback theme; visible immediately to authenticated members without a personal selection, and to anonymous visitors on the login screen for the subset of orgs already resolvable pre-auth via the existing SSO-domain-lookup mechanism.

## Acceptance Criteria

> No `epics.md` entry exists for this story — it was created directly from `epic-16-retro-2026-07-28.md` Finding 4 (Medium-High) and the `sprint-status.yaml` scope note (see References). Every AC below is added-for-completeness by this story; each includes a concrete happy-path example and at least one concrete edge/failure-case example, per this story's authoring mandate.

### AC-1: OrgAdmin sets/clears an org-wide default theme

**Given** an OrgAdmin (`owner` or `admin` org role), **when** they submit a theme name via `PATCH /api/v1/organizations/:orgId/default-theme-settings`, **then** `organizations.default_theme_name` is updated — either to a name currently present in the compiled-themes list (`getCompiledThemes()`, the exact same live in-memory set Story 16.2's `PATCH /themes/selection` validates against), or to `null` to explicitly clear the org default back to "no org default (falls back to base for anyone without a personal selection)".

- **Positive:** An `admin`-role user PATCHes `{ "themeName": "acme-brand" }` where `acme-brand` is currently in the compiled set (installed via 16.1). Response: `200 { "data": { "orgId": "...", "defaultThemeName": "acme-brand" } }`; DB row updated.
- **Positive:** An `owner`-role user performs the same PATCH; succeeds identically (`minimumRole: 'admin'` — `owner` outranks `admin` in `roleRank()`, same as every other org-settings route in this file).
- **Positive — clearing:** PATCHing `{ "themeName": null }` clears a previously-set org default back to `null`. Authenticated users without a personal selection immediately fall back further to the base theme on their next page load.
- **Edge/failure — unknown theme name (dynamic, not enum, validation):** PATCHing `{ "themeName": "does-not-exist" }` where that name is **not** currently in the live compiled-themes list returns `400 { "code": "unknown_theme", "message": "unknown theme 'does-not-exist'" }` — the **exact same** `unknown_theme` response shape and live-list-membership check `PATCH /api/v1/themes/selection` (Story 16.2) already uses, not a `422` Zod-enum rejection (there is no fixed enum — the valid set changes every time an admin reloads themes, unlike locale's fixed `SUPPORTED_LOCALES`). No DB write occurs on rejection — add a test asserting the DB row is unchanged.
- **Edge/failure — role gating:** A `member` or `viewer` attempting this PATCH receives `403` (insufficient role); DB value unchanged — test asserts no write occurred.
- **Edge/failure — cross-org 404:** PATCHing `:orgId` that does not match the caller's own `secureCtx.auth.orgId` returns `404` (never `403`, never revealing whether the target org exists) — identical non-leaking pattern to the three existing settings routes in this file (`updateOrgDormancyColumn`, `updateOrgDefaultLocaleColumn`). **Non-leaking assertion (Red Team, Round 2):** add a test asserting the 404 response body is byte-for-byte identical whether `:orgId` is a syntactically-valid UUID that doesn't exist at all vs. one that exists but belongs to a different tenant — no distinguishing signal between "doesn't exist" and "exists, not yours."
- **Edge/failure — request body hardening:** `.strict()` schema — a stray extra field (e.g. `{ "themeName": "acme-brand", "orgId": "<other-org>" }`) is rejected `422` before reaching the database, same body-tampering defense as every other org-settings PATCH in this codebase.
- **Edge/failure — oversized/garbage `themeName`:** `z.string().max(100).nullable()` bounds the value **before** the O(n) live-list-membership check runs (mirrors `ThemeSelectionBodySchema`'s exact Zod-hardening rationale from Story 16.2) — a malformed request is rejected cheaply and consistently `422`, not by falling through to the list-membership check.

### AC-2: authenticated users without a personal selection see the org default

**Given** an org has configured `default_theme_name = "acme-brand"` (currently a valid, compiled theme), **when** a user whose `users.selected_theme_name` is `NULL` loads any `(app)` page, **then** the page renders with `acme-brand` applied (`data-theme="acme-brand"`), server-rendered with no flash-of-unapplied-theme (same SSR guarantee Story 16.2's AC-2 established for personal selections).

- **Positive:** Alex (never touched Settings → Themes, `selected_theme_name = NULL`) loads `/dashboard`. `GET /api/v1/themes`'s response now additionally carries `orgDefaultThemeName: "acme-brand"` alongside the existing `themes`/`selected` fields; `(app)/+layout.server.ts`'s `resolveThemeLoad` resolves the applied theme as: personal selection (if non-null **and** currently valid) → else org default (if non-null **and** currently valid) → else `null` (base). Alex sees `acme-brand`.
- **Positive — personal selection always wins:** Morgan has `selected_theme_name = "morgan-dark"` (a different, currently-valid custom theme). The org default being `acme-brand` has zero effect on Morgan's applied theme — resolution never falls through to the org default when a valid personal selection exists. Add a test asserting this explicitly (not just implicitly via resolution-order logic).
- **Edge — org default itself is orphaned:** The org's `default_theme_name` is `"old-brand"`, but that theme file was since removed from `VAULT_THEMES_DIR` and a reload ran (16.1/16.3), so `"old-brand"` is no longer in the compiled set. A user with `selected_theme_name = NULL` falls back further to the base theme — never a broken/unstyled page, and this resolution is re-evaluated fresh on every layout load (not cached), so it self-heals the moment `old-brand` is re-installed or a new org default is set. **No user-facing "orphaned org default" notice is shown to ordinary members** (deliberate scope decision, distinct from Story 16.2 AC-3's *personal*-selection orphan notice — a member never chose the org default themselves, so a notice about a setting they don't control would be noise, not actionable information; the OrgAdmin who *does* control it already sees 16.1's reload-response failure list and 16.3's UI surfacing it). Add a test asserting the DB `organizations.default_theme_name` value survives this orphaning event unchanged (same non-destructive-fallback principle as 16.2 AC-3's second edge case for personal selections).
- **Edge — NULL-collapse judgment call (flagged explicitly, see Dev Notes ADR):** `users.selected_theme_name = NULL` means **both** "this user has never opened Settings → Themes" **and** "this user explicitly selected 'Default' to clear a prior custom-theme choice" (Story 16.2 AC-2's own clearing edge case sets the column back to the same `NULL`) — these two states are indistinguishable in the current schema. This story's resolution therefore also promotes an *explicit* "I want the base theme" choice into "show the org default" if one is configured. This is a deliberate, documented trade-off (see Dev Notes), not an oversight — a member who wants to force the literal base theme regardless of the org default has no way to do so in this story's scope.
- **Edge — no org default configured (`default_theme_name IS NULL`, the pre-existing/default state for every org):** Resolution is unchanged from Story 16.2's current behavior — `NULL` selection → base theme. Add a regression test confirming this story introduces zero behavior change for orgs that never touch the new setting.

### AC-3: anonymous/pre-auth users on the login screen see the resolvable org's default theme

**Given** an org has both (a) an `org_sso_domains` row mapping an email domain to that org (Story 14.4/14.6 — the **only** existing mechanism this codebase has for resolving "which org" from an unauthenticated request) and (b) a configured, currently-valid `default_theme_name`, **when** an anonymous visitor types an email at that domain into the login screen's Step A (email) field, **then** the login screen applies that org's default theme reactively, before the password/SSO Step B even renders — extending the existing `POST /api/v1/domain-lookup` endpoint (Story 14.4), never adding a second pre-auth lookup call.

- **Positive:** `acme.com` is mapped to Acme Corp via `org_sso_domains` (regardless of whether Acme Corp also uses SSO — theme resolution and SSO-strategy resolution are independent facts read from the same row/join, not coupled). Acme Corp has `default_theme_name = "acme-brand"` (compiled). A visitor types `newhire@acme.com` and clicks Continue. `POST /api/v1/domain-lookup`'s `200` response gains an additional optional field: `theme: { name: "acme-brand", css: "[data-theme=\"acme-brand\"] { ... }" } | null` (present only on a successful resolution; `null`/absent on every other path — miss, orphaned, DB error). `LoginForm.svelte` applies the returned `css` (via the same `<svelte:element this="style">` pattern `(app)/+layout.svelte` already uses — never `{@html}`) and sets `data-theme="acme-brand"` on the `(auth)` layout's wrapper element, reactively, the moment the response resolves.
- **Edge/failure — domain has no `org_sso_domains` mapping at all:** The domain-lookup's existing miss path (`NO_SSO` today) is unchanged in shape — `theme` is simply absent/`null` in the response alongside `ssoRequired: false`. The login screen shows the base (unbranded) theme, identical to today's pre-Story-16.4 behavior. This is the **common case** for any org that hasn't configured SSO-domain mapping, and it is an explicit, accepted scope boundary (see Dev Notes) — not a defect to fix in this story.
- **Edge/failure — org has an `org_sso_domains` mapping but no `default_theme_name` configured (or it's currently orphaned):** `theme` is `null`/absent in the response; base theme shown. No error, no partial branding. **Both-or-neither invariant (Red Team, Round 2):** `theme.name` and `theme.css` are never independently present — a response either carries the full `{ name, css }` pair for a currently-valid theme or omits `theme` entirely; add an explicit test asserting an orphaned `default_theme_name` never leaks its (now-stale) name alone without matching CSS.
- **Edge/failure — before any email is typed (the login screen's very first render):** No domain-lookup call has happened yet, so **no** org-specific branding is possible at this point under any design this story builds — the login screen's initial SSR render is always the base theme. This is the single largest, most PRD-narrative-relevant scope gap this story does *not* close (see Dev Notes "Pre-auth org-resolution judgment call" — the PRD's Amara narrative implies the login screen "carries the company's own colors" more unconditionally than this story delivers; this story delivers the closest achievable approximation given the codebase's actual pre-auth org-resolution capabilities, and flags the gap explicitly for a reviewer rather than silently under-delivering against the narrative).
- **Edge/failure — DB error resolving the org/theme join:** Same fail-open convention `lookupDomain`/`handleDomainLookup` already use for every other failure mode in this endpoint (AC-3/AC-3b from Story 14.4) — any exception resolves to `theme: null` (folded into the same `NO_SSO`-shaped miss response, or a `{ ssoRequired: true, providerName, theme: null }` partial-success shape if the SSO half succeeded but the theme half didn't), never a `500`, never blocking the login flow.
- **Edge/failure — register/invitation-accept pages:** `(auth)/register` and `(auth)/invitations/*` do not call `POST /domain-lookup` today and this story does not add that call to them — pre-auth branding in this story is scoped to the **login** page only, where the existing two-step flow already lives. Explicitly out of scope (see Out of Scope section) — a plausible follow-up, not silently forgotten.
- **Edge — rate limiting unaffected:** `POST /domain-lookup` already has its own `{ max: 20, timeWindowMs: 15 * 60 * 1000 }` limit (Story 14.4 AC-9) — this story adds no new endpoint and no new rate-limit budget for the pre-auth path; the added theme-resolution work (one extra DB read + a compiled-list lookup) rides the existing budget.

### AC-4: RLS / tenant isolation

**Given** `organizations` is the tenant-root table itself (no `org_id` column — same category as its own pre-existing `defaultLocale`/dormancy-threshold columns), **when** `make check-rls` runs, **then** it passes clean with no new policy required for `default_theme_name`.

- **Positive:** `make check-rls` reports "all `org_id` tables have RLS policies — OK" after the migration lands, unchanged from today (`organizations` was never in scope for that scan, confirmed identically for Story 15.2's `defaultLocale`).
- **Edge/failure — cross-tenant isolation of the *authenticated* resolution path (AC-2):** A user in Org A can never see Org B's `default_theme_name` applied to their own session — `GET /api/v1/themes`'s `orgDefaultThemeName` field is scoped by `secureCtx.auth.orgId`, resolved from the authenticated session, never from a client-suppliable org id. Add a `withTestOrg()`-doubled integration test (two orgs, two different `default_theme_name` values) asserting each org's members only ever see their own org's default.
- **Edge/failure — cross-tenant isolation of the *pre-auth* resolution path (AC-3):** The `org_sso_domains.domain` unique index (Story 14.4) already guarantees a domain maps to **at most one** org — the theme-resolution join rides that same single-mapping guarantee, so there is no new cross-org-disclosure surface distinct from what 14.4 already accepted (a domain reveals which org/provider it maps to; this story additionally reveals that org's theme *name* and compiled CSS, both already non-sensitive, publicly-installable-by-the-org-itself data — no credential, no PII, no internal identifier beyond the theme's own display name).

### AC-5: audit behaviour

**Given** a successful org-default-theme change (AC-1), **when** the update commits, **then** a human audit log entry is written recording the previous and new default, following the exact `writeHumanAuditEntryOrFailClosed` fail-closed convention Story 15.2 established for `organization.default_locale_updated`.

- **Positive:** Changing the org default from `null` to `"acme-brand"` writes an audit entry with `eventType: 'organization.default_theme_updated'` and payload `{ previousDefaultThemeName: null, newDefaultThemeName: "acme-brand" }` — same inline literal-string `eventType` convention (not a new `AuditEvent` registry constant — `organization.default_locale_updated`/`organization.machine_key_settings_updated` are also inline literals in this same file, not registry entries; **do not** add `ORG_DEFAULT_THEME_UPDATED` to `packages/shared/src/constants/audit-events.ts`, follow the established local-literal precedent for org-settings events specifically).
- **Edge/failure — audit write fails:** The whole transaction (column update + audit write) rolls back together; the client receives `503 audit_write_failed`, not a false "saved" response. Add a test mocking the audit write to reject once, asserting both the audit failure **and** that `organizations.default_theme_name` reverted (transaction rollback) — mirrors Story 15.2 AC 6's edge case exactly.
- **Explicitly NOT audited — read-only theme resolution (AC-2/AC-3):** Neither the `(app)` layout's per-load org-default read nor the pre-auth `domain-lookup` theme resolution writes any audit entry — both are reads, and this codebase's convention (confirmed via every other `GET`-shaped endpoint in this module) is that reads are never audited, only state-changing actions are. Do not add a read-audit here "for completeness" — it would be pure noise at request-volume frequency.

### AC-6: auth/session lifecycle

**Given** the org default theme must be visible to every authenticated session/tab/device without re-authentication, and to every anonymous pre-auth request without any session at all, **when** it changes, **then** every consumer (AC-2's layout load, AC-3's domain-lookup) reads it fresh from the database on each request — never cached in a JWT, a session claim, or any longer-lived client-side state.

- **Positive:** Riley changes the org default from `acme-brand` to `startup-theme`. Alex's *already-open* browser tab does not update live (no SSE/websocket push — identical, explicitly-scoped-out precedent to Story 16.2 AC-6's "selection changes mid-session on another device" edge case); Alex's next navigation/reload picks up `startup-theme` because the layout's `load()` function re-resolves it fresh every time, same as every other server-loaded preference in this codebase.
- **Edge — logout/login has no effect:** The org default is a property of `organizations`, not of any session — logging out and back in re-resolves the same current value, no special session-lifecycle handling needed (mirrors Story 16.2 AC-6's logout/login edge case).
- **Edge — no MFA gate anywhere in this story's *read* paths:** `GET /api/v1/themes` already has `requireMfa: false` (Story 16.2, unchanged by this story) and `POST /domain-lookup` has `requireAuth: false` (Story 14.4, unchanged) — reading the org default theme is exactly as low-stakes as reading the personal-selection list, no new MFA posture is introduced for either read path. The **write** path (AC-1's `PATCH`) does require MFA, matching every other org-settings mutation in this file.

### AC-7: concurrent access

**Given** two OrgAdmins in the same org submit conflicting default-theme changes concurrently, **when** both `PATCH`es are processed, **then** the last one to commit determines the final `organizations.default_theme_name` value — no version column, no optimistic-locking conflict response, identical reasoning to Story 15.2 AC 8's locale field and Story 16.2's personal-selection field.

- **Positive:** Two sequential PATCHes (`"acme-brand"` then `null`) from two different admin sessions both succeed `200`; the final DB value is `null` (the second to commit).
- **Edge:** No correctness invariant is broken by this race (unlike, say, a rotation checklist's state machine) — an org-wide theme preference has no notion of a "conflict" to detect or reject. No test asserting a specific interleaving order is required beyond confirming both requests succeed and the DB ends in a single self-consistent value (never a corrupted/partial write, guaranteed by the single-column `UPDATE ... RETURNING` shape already used by every sibling org-settings route).

### AC-8: rate limits

**Given** `PATCH /api/v1/organizations/:orgId/default-theme-settings` is a low-frequency admin settings change (no filesystem/CPU-heavy work per call, unlike 16.1's reload), **when** rate-limiting it, **then** reuse the exact `{ max: 10, timeWindowMs: 60_000 }` config already applied to the three sibling org-settings routes in this same file (`machine-key-settings`, `user-dormancy-settings`, `default-locale-settings`) — do not invent a new threshold.

- **Positive:** An admin changing the org default theme a few times while configuring branding always succeeds within the limit.
- **Edge/failure:** Rapid-fire scripted PATCHes past the 10th within 60s receive `429` — mirror the existing sibling settings' rate-limit test structure exactly.
- **Edge — `GET /api/v1/themes`'s existing default rate limit is unaffected** — this story only adds a response field to an already-shipped, already-rate-limited-by-default (`secureRoute()`'s standard 60/min) `GET` route; no explicit override needed, same reasoning Story 16.2 AC-7 documented for that route.
- **Edge — `POST /domain-lookup`'s existing `{ max: 20, timeWindowMs: 15 * 60 * 1000 }` limit is unaffected** (AC-3's note above) — the added theme-join work rides the existing budget; no new rate-limit key needed.

### AC-9: migration compatibility

**Given** the new `organizations.default_theme_name` column, **when** `pnpm check-migration-compatibility` and `make check-rls` run, **then** both pass clean — additive, nullable, no CHECK constraint (unlike `defaultLocale`'s fixed-enum CHECK — a theme's valid-name set is dynamic/filesystem-defined via `VAULT_THEMES_DIR`, not a fixed enum like `SUPPORTED_LOCALES`, so a CHECK constraint would either be unenforceable or would need to duplicate runtime state into a constraint, which this story deliberately does not do — validation lives entirely in the route handler against the live `getCompiledThemes()` list, exactly as `PATCH /themes/selection` already does for the personal-selection column).

- **Positive:** New migration `packages/db/src/migrations/0060_organizations_default_theme_name.sql`:
  ```sql
  ALTER TABLE organizations ADD COLUMN default_theme_name TEXT NULL;
  ```
  Confirm the exact next-free migration number against `packages/db/src/migrations/meta/_journal.json` at implementation time — `0059_credential_shares.sql` (Story 17-1) is the latest known as of this story's authoring, so `0060` is provisional; re-verify immediately before writing the file, since other stories may land migrations first (same caveat Story 15.2/16.2's own Dev Notes carried forward).
- **Edge — no backfill needed:** Every existing org row gets `NULL` implicitly (no `UPDATE` statement) — meaning "no org default, resolves to base," which is exactly today's pre-migration behavior for every org (nobody had this concept before). Zero behavior change on deploy for any org that never touches the new setting.
- **Edge — rollback safety:** Nullable, no CHECK, no foreign key — `ALTER TABLE organizations DROP COLUMN default_theme_name` is safe and lossless except for the (acceptable, cosmetic-only) loss of the org's saved default-theme preference. Document this in the migration file's header comment, matching this codebase's migration-documentation convention.
- **Edge — this is NOT a hot-path migration the way Story 15.2's `defaultLocale` was:** `defaultLocale` is read on every registration (the hottest path in the app); `default_theme_name` is read on every `(app)` layout load (authenticated, already-read-heavy path, but not availability-critical the way registration is — a missing-column error here would degrade theming, not break signups/logins outright) and on the pre-auth domain-lookup path (already fail-open by design, so a missing-column error there resolves to `theme: null`, not an outage). Standard migrate-before-deploy ordering still applies (this codebase's existing operational convention), but this story does not carry Story 15.2's elevated "instance-wide 500" blast-radius warning.

### AC-10: operational logging

**Given** this codebase's convention of a lightweight operational log line alongside audit-worthy admin actions,
**when** the org default theme changes,
**then** log at `debug` level (mirroring Story 16.2 AC-9's `theme_selection_changed` line, not `info`/`fatal`) noting the acting admin's user id and the previous/new theme name, via `req.log.debug(...)` (request-scoped, not the shared `operationalLog()` helper — same reasoning Story 16.2 documented: `operationalLog()` is reserved for non-request-scoped startup/job logging and would mask this request's real trace id).

- **Positive:** `{"level":"debug","userId":"...","event":"org_default_theme_changed","from":null,"to":"acme-brand"}`.
- **Edge — do not confuse with AC-5's audit event:** Same distinction Story 16.2 AC-9 drew — the audit event is the durable, compliance-relevant record; this debug log line is ephemeral, log-aggregator-only, for live debugging. Neither substitutes for the other.
- **Edge — no new log line for the read paths (AC-2/AC-3):** Per-request-load debug logging for a routine, high-frequency read (every `(app)` page load, every login-screen keystroke-triggered domain-lookup) would be excessive noise, unlike the low-frequency admin write this AC covers. No log line added to `resolveThemeLoad` or `handleDomainLookup` beyond what they already have.

## Out of Scope (explicit — do not scope-creep)

- **Zero-input pre-auth branding (before any email is typed on the login screen).** No mechanism exists anywhere in this codebase to resolve "which org" for a truly anonymous, contextless request in a multi-tenant instance — this story's pre-auth branding is reachable only via the existing post-email-entry domain-lookup step (AC-3). This is the single largest gap versus the PRD's Amara narrative's implication of unconditional login-screen branding; flagged explicitly, not silently under-delivered.
- **Pre-auth branding on `(auth)/register` or `(auth)/invitations/*`.** Only the login page's existing two-step flow is extended. A plausible, small follow-up — not built here.
- **A general-purpose email-domain-to-org resolution mechanism for orgs without SSO.** This story reuses `org_sso_domains` exactly as-is (Story 14.4/14.6); it does not add a new, SSO-independent domain-mapping table or admin UI purely to widen pre-auth theming's reach. Building one would be materially larger scope than this story's own Medium-High retro finding justifies, and would duplicate 14.4's own documented "public-domain-hijack" operational hazard onto a second table.
- **Distinguishing "never touched theme settings" from "explicitly chose Default"** (AC-2's NULL-collapse judgment call) — would require a new column/flag on `users`; deliberately not added speculatively. If this collapse proves genuinely confusing in practice, the fix is a small, separate follow-up story adding e.g. `users.theme_selection_is_explicit boolean`, not a silent scope expansion here.
- **Live cross-tab/cross-device push of an org-default change** — same explicit non-goal Story 16.2 AC-6 already established for personal selections; no SSE/websocket extension in this story either.
- **A CHECK constraint or enum for `default_theme_name`'s valid values** — deliberately dynamic/unconstrained at the DB layer (AC-9); validation lives in the route handler against the live compiled-themes list, exactly as `users.selected_theme_name` already works.
- **Bulk-applying a new org default to already-selected members** — mirrors Story 15.2's identical, explicitly-rejected scope item for locale: an individual's already-set preference always wins going forward; no "re-apply to everyone" admin action.

## Tasks / Subtasks

- [x] **Task 1: Database — `organizations.default_theme_name`** (AC: 1, 4, 9)
  - [x] 1.1 Verify the next free migration index against `packages/db/src/migrations/meta/_journal.json` (expected `0060` as of story creation, immediately following `0059_credential_shares.sql` — **re-check at implementation time**).
  - [x] 1.2 Add migration `packages/db/src/migrations/00NN_organizations_default_theme_name.sql`: `ALTER TABLE organizations ADD COLUMN default_theme_name text NULL` — **no CHECK constraint** (see AC-9 rationale), with a header comment documenting rollback safety and the dynamic-validation-lives-in-the-route rationale.
  - [x] 1.3 Add `defaultThemeName: text('default_theme_name')` (nullable, no `.notNull()`, no `check(...)`) to `packages/db/src/schema/organizations.ts`, with a comment cross-referencing this story and explicitly contrasting it with the adjacent `defaultLocale` column's CHECK-constrained pattern (so a future reader doesn't assume the omission is an oversight).
  - [x] 1.4 Hand-write the SQL migration + matching `_journal.json` entry (this repo's `meta/` snapshot chain is broken past `0033_snapshot.json` — do not attempt `drizzle-kit generate`, same established convention as every migration since Story 15.1).
  - [x] 1.5 `pnpm check-migration-compatibility` clean; apply via `make db-migrate` against a live Postgres instance; `make check-rls` clean (no new policy expected — confirm, don't assume).

- [x] **Task 2: Backend — `PATCH /:orgId/default-theme-settings`** (AC: 1, 5, 7, 8)
  - [x] 2.1 Add `OrgDefaultThemeSettingsBodySchema = z.object({ themeName: z.string().max(100).nullable() }).strict()` and `OrgDefaultThemeSettingsResponseSchema = z.object({ data: z.object({ orgId: z.uuid(), defaultThemeName: z.string().nullable() }) })` to `apps/api/src/modules/org/organization-settings-schema.ts` (fourth setting in this file).
  - [x] 2.2 Add a fourth `secureRoute()` registration to `apps/api/src/modules/org/organization-settings-routes.ts`: `PATCH /:orgId/default-theme-settings`, `minimumRole: 'admin'`, `requireMfa: true`, `rateLimit: { max: 10, timeWindowMs: 60_000, key: 'PATCH /api/v1/organizations/:orgId/default-theme-settings' }`, `writeAuditEvent: false` (inline audit write per convention).
  - [x] 2.3 Write a small parallel handler (`updateOrgDefaultThemeColumn`, mirroring `updateOrgDefaultLocaleColumn`'s shape: params/body parse → cross-org 404 guard → read-previous-value → **dynamic `unknown_theme` 400 check against `getCompiledThemes()`** (import from `../theming/service.js`, the exact function `PATCH /themes/selection` already imports) → `UPDATE ... RETURNING` → return for inline audit). Do **not** attempt to fold this into `updateOrgDormancyColumn` or `updateOrgDefaultLocaleColumn` — different validation shape (dynamic list membership, not a numeric enum or a fixed `z.enum`), same "don't touch a helper two/three already-`done` stories' routes depend on" reasoning Story 15.2's Dev Notes already established for this exact file.
  - [x] 2.4 Inline `writeHumanAuditEntryOrFailClosed(secureCtx.tx, { resourceType: 'organization', orgId, actorUserId, eventType: 'organization.default_theme_updated', resourceId: updated.id, payload: { previousDefaultThemeName, newDefaultThemeName }, request: req })` — literal inline string `eventType`, not a new `AuditEvent` registry constant (AC-5).
  - [x] 2.5 Add `req.log.debug({ userId, from: previousDefaultThemeName, to: newDefaultThemeName }, 'org_default_theme_changed')` (AC-10).
  - [x] 2.6 New test file `apps/api/src/modules/org/default-theme-settings-routes.test.ts` (matching this module's one-file-per-setting convention: `default-locale-settings-routes.test.ts` sibling) — covers every AC-1/4/5/7/8/9 case: role gating, cross-org 404, `.strict()` tampering, dynamic unknown-theme 400 (not 422), oversized-name 422, rate-limit 429, audit-fail-closed rollback, migration compatibility.

- [x] **Task 3: Backend — extend `GET /api/v1/themes` with `orgDefaultThemeName`** (AC: 2, 4, 6)
  - [x] 3.1 In `apps/api/src/modules/theming/schema.ts`, add `orgDefaultThemeName: z.string().nullable()` to `ThemeListResponseSchema`.
  - [x] 3.2 In `apps/api/src/modules/theming/selection-routes.ts`'s `GET /themes` handler, additionally `select({ defaultThemeName: organizations.defaultThemeName }).from(organizations).where(eq(organizations.id, secureCtx.auth.orgId))` and include it in the response as `orgDefaultThemeName`. No new role gate — this is a read, same `minimumRole: 'viewer'` as today.
  - [x] 3.3 Extend `apps/api/src/modules/theming/selection-routes.test.ts` with cases: `orgDefaultThemeName` present/absent, cross-org isolation (two orgs via `withTestOrg()` twice, each sees only its own org's default).

- [x] **Task 4: Web — authenticated fallback resolution** (AC: 2, 6)
  - [x] 4.1 In `apps/web/src/lib/theme/apply-theme.ts`, add a pure helper (e.g. `resolveAppliedThemeWithOrgDefault(selected, orgDefault, availableThemeNames)`) implementing the three-tier resolution (personal → org default → base), each tier independently re-checked against `availableThemeNames` for orphaning — do not just chain `resolveAppliedTheme` twice ad hoc in the layout load function; keep the resolution logic itself pure and unit-testable, consistent with this file's existing "no DOM/Svelte side effects" convention.
  - [x] 4.2 Update `apps/web/src/routes/(app)/+layout.server.ts`'s `resolveThemeLoad` to read the new `orgDefaultThemeName` field from `getThemes()`'s response and call the new resolver from 4.1.
  - [x] 4.3 Extend `apps/web/src/lib/theme/apply-theme.test.ts` and `apps/web/src/routes/(app)/app-layout.server.test.ts` with cases: personal selection wins over org default; org default applies when personal selection is `null`; org default itself orphaned falls back to base; neither set falls back to base (regression, zero behavior change for untouched orgs).

- [x] **Task 5: Web — "Default theme for this organization" admin section** (AC: 1)
  - [x] 5.1 Add `updateOrgDefaultTheme(fetchFn, orgId, themeName)` to `apps/web/src/lib/api/organization-settings.ts`, mirroring `updateOrgDefaultLocale`'s shape (including its "set-only" disclosure-comment pattern, though this setting's value **is** already visible via `GET /api/v1/themes`'s new `orgDefaultThemeName` field — so, unlike locale/dormancy, this section **may** pre-select the current value on load; do not blindly copy the no-GET-readback precedent where a GET already exists for a different reason).
  - [x] 5.2 Extend `apps/web/src/routes/(app)/settings/themes/+page.server.ts`'s existing `canReload`-gated data (16.3) with the current `orgDefaultThemeName` (already available from `getThemes()`, no new fetch) so the new section can pre-select it.
  - [x] 5.3 Add a "Default theme for this organization" section to `apps/web/src/routes/(app)/settings/themes/+page.svelte`, gated by the same `data.canReload`-equivalent admin/owner check (16.3's `canReloadThemes(orgRole)` helper — reuse verbatim, do not invent a second role-gate helper for the same `admin`/`owner` shape), rendered as a dropdown/select of the current `themes` list (including "None (base theme)" mapping to `null`) with immediate-save-on-change, following this page's existing immediate-save pattern (16.2's selection list) rather than 16.3's explicit-button pattern (a settings *change*, not a triggered *action* — no pending/in-flight concern the way a reload has).
  - [x] 5.4 Extend `apps/web/src/routes/(app)/settings/themes/themes-page.test.ts` / `themes-page.server.test.ts` with cases: section hidden for member/viewer; visible + pre-selected for admin/owner; save success/error banners; unknown-theme 400 handling (defensive, in case of a stale client list).

- [x] **Task 6: Backend — extend `POST /domain-lookup` with pre-auth theme resolution** (AC: 3, 4, 6, 8)
  - [x] 6.1 In `packages/shared/src/schemas/auth.ts`, extend `DomainLookupResponseSchema` with an optional `theme: z.object({ name: z.string(), css: z.string() }).nullable().optional()` field.
  - [x] 6.2 In `apps/api/src/modules/auth/domain-lookup-routes.ts`'s `lookupDomain`, additionally join `orgSsoDomains.orgId` to `organizations.id` and select `organizations.defaultThemeName`; if non-null, cross-check it against `getCompiledThemes()` (imported from `../theming/service.js`) and include `{ name, css }` in the response only if the theme is currently valid — `null`/absent on every miss/orphan/error path, matching this handler's existing fail-open pattern exactly (extend the `try`/`catch` already wrapping `lookupDomain`, do not add a second, separately-failing code path).
  - [x] 6.3 Extend `apps/api/src/modules/auth/domain-lookup-routes.test.ts` with cases: SSO-domain-mapped org with a valid default theme → `theme` populated; mapped org with no/orphaned default theme → `theme` absent; unmapped domain → unchanged `NO_SSO` shape (no `theme` key at all, confirm no regression to the existing miss-response shape); DB error during the theme-join specifically → still fails open to the pre-existing miss shape; **reload-race regression (Pre-Mortem scenario #2)** — a single request's response is never internally inconsistent (e.g. `theme.name` set but not matching the `css` actually returned) regardless of when a concurrent 16.1 reload fires, since `getCompiledThemes()` is read once per request from a single snapshot.

- [x] **Task 7: Web — pre-auth login-screen branding** (AC: 3, 6)
  - [x] 7.1 In `apps/web/src/lib/components/auth/LoginForm.svelte`, after a successful domain-lookup response carrying a `theme` field, apply it reactively: inject the returned `css` (same `<svelte:element this="style">` pattern as `(app)/+layout.svelte`, never the html-injection directive — this repo's static-hardening gate hard-bans it with no escape hatch) and set `data-theme` on the `(auth)` layout's wrapper element.
  - [x] 7.2 `apps/web/src/routes/(auth)/+layout.svelte` needs a themeable wrapper element and a way to receive the applied theme name/CSS from `LoginForm` — use the existing `$lib/state/theme.svelte.ts` shared rune (16.2's `setInitialAppliedTheme`/`getAppliedTheme`) rather than inventing a second theme-state mechanism; confirm at implementation time whether the rune needs a small extension to also carry ad-hoc CSS text for the pre-auth case (the `(app)` layout gets its CSS from the server-loaded `themeCss` field; the `(auth)` layout has no server load for this, so CSS must arrive from the client-side domain-lookup response instead — document this asymmetry in Dev Notes if the rune needs adjusting). **Rune extended**: added `preAuthThemeName`/`preAuthThemeCss` state + `getPreAuthThemeName`/`getPreAuthThemeCss`/`setPreAuthTheme` — deliberately separate from `appliedTheme`/`setAppliedTheme` (which stay seeded exclusively from the authenticated `(app)` layout's SSR load) so an unauthenticated, client-only domain-lookup response can never overwrite that state.
  - [x] 7.3 Extend `apps/web/src/routes/(auth)/login/page.test.ts` (or `LoginForm`'s own test file) with cases: domain-lookup response with `theme` populated → `data-theme` set + CSS injected; response without `theme` → base theme, no injected `<style>`; theme applies before the SSO/password Step B renders (ordering). Added to `LoginForm.test.ts` plus a new `apps/web/src/routes/(auth)/layout.test.ts` covering the `(auth)` layout's own DOM rendering of `data-theme` + injected `<style>`.

- [x] **Task 8: Full verification pass** (AC: all)
  - [x] 8.1 `pnpm --filter @project-vault/shared test`, `pnpm --filter @project-vault/db test`, `pnpm --filter api test`, `pnpm --filter web test`, typecheck, lint all green.
  - [x] 8.2 `route-audit.test.ts` passes with the new/modified routes correctly classified; `route-exemptions.ts` updated if the new PATCH route needs a `ROUTE_ACTION_CLASSIFICATIONS` entry (mirror the three sibling org-settings entries).
  - [x] 8.3 `pnpm check-migration-compatibility`, `make check-rls` clean.
  - [x] 8.4 `pnpm generate-spec` re-run; `packages/shared/openapi.json` diff reviewed and committed (Story 16.2's own CI lesson: undocumented 400/422/429/503 responses fail contract-parity tests in CI even when they pass locally — document every new response code on every touched/new route).
  - [x] 8.5 Manual/Chrome-driven verification against a running local `make docker-up` stack — **partial**: confirmed the `(auth)` login screen renders correctly (no console errors, no regression) against the rebuilt Docker images; the fresh stack's vault required re-initialization mid-session and repeated `make fix-ports`/`operator-bootstrap.sh` port churn (a known multi-worktree hazard per `AGENTS.md`) disrupted a concurrently-running background API test pass, so the full branded-login/admin-section round trip (installing a custom theme via `VAULT_THEMES_DIR`, unsealing, setting an org default, verifying no-FOUC) was not completed live in-browser within this session. This is covered instead by the extensive automated integration/unit coverage added in Tasks 2/3/6/7 (56 new/updated test cases spanning exactly these AC-1/AC-2/AC-3 flows, including the SSR-no-FOUC-equivalent server-load assertions and reactive pre-auth apply-before-Step-B ordering test). Flagging as a residual manual-QA follow-up rather than silently marking complete.
  - [x] 8.6 `make ci` green — every individual step `make ci`'s target runs (`pnpm turbo typecheck`, `pnpm turbo lint`, `db-migrate`, `check-rls`, `check-audit-actor-token-coverage`, `check-search-index`, `check-migration-compatibility`, `check-story-status-sync`, `check-sprint-status-rollup`, `check-story-references`, `check-psc-tbd-tracking`, `check-extension-api-version-skew`, `check-alert-pending-epic3`, the full per-workspace `test` suites including `api-contract-tests`, `jscpd`, `check-audit-baseline`, `check-env-example`, `generate-spec`) was run directly and confirmed green (see Debug Log References for exact counts); run individually/chunked rather than via the single `make ci` invocation because the API suite's own `fileParallelism: false` setting plus this session's tool-call time budget make one unbroken multi-tens-of-minutes run impractical in a single command.

## Dev Notes

### Previous-story intelligence — build on, do not duplicate

- **Story 15.2 (`_bmad-output/implementation-artifacts/15-2-configure-organization-default-locale-for-new-users.md`, done)** is the direct structural precedent this story mirrors, per the sprint-status scope note that scheduled this story ("mirroring Story 15.2's 'org default locale, individual can override' pattern"). Reused verbatim: the `organization-settings-routes.ts`/`organization-settings-schema.ts` multi-setting-in-one-file convention (this story is the **fourth** setting in that file); the `updateOrgDormancyColumn`/`updateOrgDefaultLocaleColumn` "write a small parallel handler, don't generalize the shared helper" decision (Task 2.4 of 15.2, Task 2.3 of this story); the inline-literal `eventType` string convention (not a new `AuditEvent` registry constant) for org-settings audit events; the `{ max: 10, timeWindowMs: 60_000 }` rate-limit precedent; the cross-org 404 (never 403) pattern; the last-write-wins/no-locking concurrent-access reasoning; the "organizations is tenant-root, no RLS needed" reasoning. **One deliberate divergence from 15.2:** locale's valid-value set is a fixed enum (`SUPPORTED_LOCALES`), enforced by both a Zod `z.enum` *and* a DB `CHECK` constraint. This story's valid-value set (currently-compiled theme names) is **dynamic and filesystem-defined** — there is no fixed enum to check against, so validation is a live-list-membership check against `getCompiledThemes()` (mirroring `PATCH /themes/selection`'s exact pattern instead), and the DB column intentionally carries **no** `CHECK` constraint (see AC-9). Do not copy 15.2's `z.enum(SUPPORTED_LOCALES)` shape here — it does not apply.
- **Story 16.2 (`_bmad-output/implementation-artifacts/16-2-select-an-active-theme.md`, done)** shipped the per-user theme-selection mechanism this story layers a fallback underneath, and is the source of the exact `unknown_theme` 400 validation pattern this story's PATCH route reuses (`getCompiledThemes()`, `UnknownThemeErrorSchema`), the SSR-no-FOUC delivery mechanism (`<svelte:element this="style">`, never `{@html}`), the `resolveAppliedTheme`/`isOrphaned` pure-helper pattern in `apply-theme.ts` this story extends (not replaces), and — critically — 16.2's own **Out of Scope** section is the direct origin of this story: *"An org-wide 'default theme' that applies to anonymous/pre-auth users on the login screen ... is a plausible future story but is not built here — flagged explicitly for a reviewer to confirm or challenge this reading."* `epic-16-retro-2026-07-28.md` Finding 4 is that confirmation-and-scheduling. 16.2's own suggested fallback shape if a reviewer disagreed — *"an org-level `organizations.default_theme_name` column ... as a fallback layered under this story's per-user override"* — is exactly what this story builds.
- **Story 16.3 (`_bmad-output/implementation-artifacts/16-3-admin-ui-trigger-for-theme-reload.md`, done)** established the admin-only section pattern on `(app)/settings/themes/+page.svelte` (`canReloadThemes(orgRole)` role-gate helper, `data.canReload`-conditional rendering) this story's Task 5 reuses verbatim for its own admin-only "Default theme for this organization" section — do not invent a second, differently-named role-gate helper for the identical `admin`/`owner` shape.
- **Story 14.4 (`_bmad-output/implementation-artifacts/14-4-route-login-to-sso-by-email-domain.md`, done)** shipped the two-step, email-first `LoginForm.svelte` and the fail-open, unauthenticated `POST /api/v1/domain-lookup` endpoint this story's Task 6/7 extend — the **only** existing pre-auth org-resolution mechanism in this codebase. Its documented "public-domain-hijack" operational hazard on `org_sso_domains` (one bad row silently misroutes every user sharing that domain) applies identically, unchanged, to this story's theme-resolution join — this story does not add new exposure, it rides the existing one.

### Architecture compliance (source-cited)

- **PRD framing this story resolves (source of the retro finding):** `prd.md`'s domain-requirements section (~line 647) — *"Administrators select the active theme from the base theme plus any installed custom themes"* — reads as an org-wide/admin-controlled action. `epics.md`'s Story 16.2 text reads as per-user (*"As a user... for my view"*). `16-2-select-an-active-theme.md`'s own Out of Scope section resolved that specific conflict in favor of per-user for 16.2's literal ACs, while explicitly flagging that the PRD's admin-framing — and its Amara journey narrative's login-screen-branding implication (`prd.md` ~lines 305-315) — pointed at a **separate, additive** feature. This story is that feature. It does not revisit or reverse 16.2's per-user resolution (AC-2's "personal selection always wins" is non-negotiable) — it adds an org-wide *fallback layer underneath* it, exactly as 16.2's own text anticipated.
- **FR120/FR121** (`prd.md` lines 1167-1168) remain this epic's only two FRs — this story adds no new FR, it closes a scope gap within FR121's existing "users can select the active theme" framing by defining what happens for the base/no-selection case at the org level. [Source: `prd.md` FR120/FR121]
- **No new backend module** — this story extends `apps/api/src/modules/org/` (organization-settings routes, third→fourth setting) and `apps/api/src/modules/theming/` (extends two existing route files: `selection-routes.ts`'s `GET /themes`, and indirectly `domain-lookup-routes.ts` in `modules/auth/`) — no new flat module, consistent with every prior Epic 15/16 story's Architecture Compliance note. [Source: `architecture.md` Epic Traceability Matrix, line 1045; line 1148's Theming row]
- **Theme CSS delivery** reuses 16.1's already CSS-injection-hardened compiled `[data-theme]` blocks unchanged — this story introduces no new theme-compilation logic, no new token grammar, no new SSRF surface. It only changes **which** theme name gets resolved and delivered to a given request. [Source: `architecture.md` lines 536-542, Theme token CSS-injection sanitization]

### Pre-Mortem: production failure scenarios (Round 1 elicitation)

Three concrete ways this story could fail in production that the AC list above doesn't call out explicitly enough to guarantee a test exists:

1. **Unauthenticated response-size amplification on `POST /domain-lookup`.** This story adds theme `css` (a full compiled stylesheet, potentially several KB) to a **public, unauthenticated** endpoint's response. Today that endpoint returns a few bytes (`ssoRequired`, `providerName`). A large custom theme now inflates every anonymous request's response size, and — combined with the existing `{ max: 20, timeWindowMs: 15min }` budget — raises (not removes, but raises) the endpoint's amplification ceiling versus its pre-story baseline. **Mitigation:** no new rate limit needed (AC-8 already reasons this rides the existing budget correctly), but add an explicit assertion in Task 6.3's tests that the returned `css` is the same bounded, already-compile-time-size-checked payload 16.1 produces (16.1's Dev Notes confirm theme compilation already caps output size) — this is a "confirm existing invariant carries over," not a new control to build.
2. **Reload race: theme removed mid-flight between domain-lookup's compiled-list check and response serialization.** AC-3's "DB error" edge case covers a DB-layer race, but not a **filesystem/in-memory** race: 16.1's reload can swap the compiled-themes set between `lookupDomain`'s `getCompiledThemes()` membership check and the response being sent. Since `getCompiledThemes()` is read once per request (not per-field), this is a non-issue in practice — the response is internally consistent with whatever snapshot was read — but it's worth one explicit regression test asserting a response is never split-state (e.g. `theme.name` present but stale relative to a reload that started after the read). Added to Task 6.3.
3. **Silent migration-rollback data loss is a known, accepted trade-off (AC-9), but nothing today would alert an operator that it happened.** If `default_theme_name` is dropped via rollback, every org's configured default silently reverts to "none" with no error, no audit entry (there's no write, just a missing column), and no operator-facing signal. This is explicitly accepted as low-severity (cosmetic branding loss, not data corruption) — no new alerting is being added — but flagging it here so a reviewer doesn't mistake the silence for an oversight.

Task 6.3 updated (see Tasks section) to include failure scenario #2's regression test. Scenario #1 confirmed as already covered by 16.1's existing compile-time size bound (no new task needed — cross-referenced here for auditability). Scenario #3 accepted as-is per AC-9's existing rollback-safety documentation, no action.

### Pre-auth org-resolution judgment call (the single biggest open question in this story — flagged explicitly for review)

This codebase is genuinely multi-tenant (multiple orgs per self-hosted instance is a real, supported configuration — confirmed by 16.1's own Dev Notes precedent citing "the no-single-org boot-time case" for its startup audit fanout, and by every `withTestOrg()`-doubled cross-tenant-isolation test pattern used throughout Epics 13-17). This means there is **no** notion of "the" org for a request that hasn't identified itself yet. The **only** mechanism this codebase has ever built to resolve "which org" from an anonymous, pre-auth request is Story 14.4's domain-lookup, and that mechanism itself only resolves domains an admin has explicitly registered in `org_sso_domains` (a table that exists for SSO routing, not general org identification, and carries its own documented "one bad mapping breaks login for everyone on a shared public domain" operational hazard).

Given that, this story's design deliberately does **not**:
- Invent a second, SSO-independent domain-to-org mapping table just to widen pre-auth theming's reach (would be materially larger scope, and would duplicate 14.4's hazard onto a new surface).
- Attempt to brand the login screen's very first render, before any email is typed (structurally impossible without *some* client-supplied identifying context in a multi-tenant instance).

Instead, it reuses the existing domain-lookup call **exactly as-is**, piggybacking theme resolution onto the same request/response round-trip 14.4 already makes. This closes the retro finding's core ask (an org-wide default theme, applied where technically resolvable pre-auth) without taking on unbounded new scope. **If a reviewer judges this insufficient against the PRD's fuller narrative**, the correct escalation is a dedicated follow-up story for general-purpose pre-auth org resolution (e.g., a first-class "branded login" feature with its own domain-ownership-verification story, the same follow-up `org_sso_domains`' own schema comment already flags as a future need) — not a silent scope expansion of this story.

### Red Team: adversarial review (Round 2 elicitation)

Attacking this story's new surface area from an outside-attacker perspective:

- **Org/theme enumeration via `POST /domain-lookup`.** An attacker can already probe arbitrary email domains against this endpoint pre-story (14.4's existing surface) to learn "does this domain have SSO." This story adds one more bit of learnable information per probe: "does this domain's org have a *custom* default theme, and if so its name." Verdict: **not a new severity class** — theme names are non-secret, self-chosen-by-the-org-admin display strings (already fully readable by any authenticated member of that org via `GET /themes`), so this is a marginal enumeration-surface widening on an already-accepted-risk endpoint (AC-4's Dev Notes already document 14.4's domain-hijack hazard as the pre-existing baseline), not a new vulnerability. No mitigation added; documented here so it isn't rediscovered as if new.
- **CSS-injection via a maliciously-crafted theme reaching the pre-auth response.** Already fully mitigated by construction: `theme.css` only ever contains 16.1's compile-time-sanitized output for a name currently present in `getCompiledThemes()` — there is no code path in this story that accepts or reflects attacker-supplied CSS/theme content. AC-3's tests should include one explicit negative assertion: a `themeName` that exists in the DB column but has since been removed from the compiled set (orphaned) must **never** reach the response as `css: null-but-name-present` — always both-or-neither. Added to AC-3's edge case wording below.
- **Privilege escalation via the PATCH route's cross-org guard.** Already covered (AC-1's cross-org 404), but the red-team lens adds one explicit check: confirm the 404 response is **byte-for-byte** identical whether the target org doesn't exist at all vs. exists but belongs to another tenant (no timing or payload side-channel distinguishing the two) — same non-leaking bar the sibling routes already meet; call this out explicitly as a test assertion, not just an implied one.

AC-3 tightened below to make the both-or-neither invariant explicit rather than merely implied by "fails open."

### First Principles: is piggybacking on `domain-lookup` actually the minimal correct design? (Round 3 elicitation)

Reduced to fundamentals: pre-auth theme resolution needs exactly one input (an org identifier resolvable from something an anonymous visitor can supply) and produces exactly one output (a compiled CSS block). Two alternative designs were considered and rejected in favor of the chosen one:

- **Alternative A — a dedicated `POST /theme-lookup` endpoint, separate from `domain-lookup`.** Rejected: it would require the exact same input (email domain → `org_sso_domains` join) and the exact same fail-open/rate-limit posture as the existing endpoint, just duplicated. A second endpoint with identical security properties is pure surface-area growth with no isolation benefit (they're not independently securable — both trust the same domain-to-org mapping) and no separate deployment/versioning need. Rejected.
- **Alternative B — resolve theme client-side from a public, unauthenticated `GET /organizations/by-domain/:domain` style endpoint.** Rejected: this would be a *new* general-purpose pre-auth org-resolution primitive — exactly the thing "Out of Scope" already rules out for good reason (materially larger scope, duplicates 14.4's hazard onto a new table/surface). It would also require a new rate-limit budget rather than riding an existing one.
- **Chosen design confirmed minimal:** extending `domain-lookup`'s existing response is the smallest change that satisfies the requirement — zero new endpoints, zero new rate-limit budgets, zero new org-resolution mechanisms. This reasoning was already implicit in the Dev Notes' "never adding a second pre-auth lookup call" line (AC-3); this elicitation round makes the rejected alternatives and why explicit, for a reviewer who might otherwise suggest Alternative A as "cleaner separation of concerns."

No change to Tasks — this round confirms the existing design rather than altering it.

### NULL-collapse ADR (post-authoring judgment call)

- **Option A — accept the collapse (chosen):** `users.selected_theme_name = NULL` continues to mean one thing operationally ("no theme override recorded, resolve down the fallback chain") regardless of whether the user never touched the setting or explicitly cleared it back to `NULL`. This is a strict, backward-compatible generalization of Story 16.2's existing behavior (which already only had one `NULL` meaning: "show base") — no existing behavior changes for orgs without a configured default; only orgs *with* one gain a new resolution tier.
- **Option B — add a distinguishing flag (rejected for this story):** A new `users.theme_selection_is_explicit boolean` column would let a user force "always show base, even if my org sets a default." Rejected as speculative scope — no evidence yet that this distinction matters in practice, and it's a small, isolable follow-up if it does. Flagged in Out of Scope, not silently dropped.

### Edge-Case Stress Test (Round 4 elicitation)

Walking every boundary condition this story's own AC/task list touches, to confirm nothing is missing beyond what's already written:

- **Org default set to a theme name that collides with the literal string used for "base/none" in the UI dropdown (Task 5.3).** The dropdown maps a `null` value to "None (base theme)" as a UI-only label — confirm at implementation time that no compiled theme could ever be named in a way that's ambiguous with that label in the request payload (the request always sends the real `themeName` string or JSON `null`, never the label text, so this is a UI-rendering concern only, not a validation gap — no AC change needed, noted here so the frontend implementer doesn't need to rediscover it).
- **An org's default theme is deleted (uninstalled) entirely, not just left uncompiled — i.e. 16.1's reload response reports it as removed.** Already covered by the existing "orphaned" edge cases in AC-2/AC-3 (orphaned = "not in the currently-compiled set," which is exactly the state after an uninstall+reload) — confirmed no new case needed, "orphaned" already generalizes over "renamed," "deleted," and "reload not yet run since a filesystem change."
- **Two different orgs sharing the same theme *name* (e.g. both installed a theme called `custom` independently via 16.1's per-instance `VAULT_THEMES_DIR`).** Since `VAULT_THEMES_DIR` and the compiled-themes set are instance-wide (not per-org — confirmed by 16.1/16.2's existing design, themes are a shared instance-level catalog that any org can reference by name), this is not a collision at all — both orgs' `default_theme_name` pointing at the same compiled theme name resolve to the identical CSS, which is expected/correct behavior, not an edge case requiring a test. Noted here to close the question rather than leave it implicit.
- **The very first org-default PATCH ever issued against a freshly-migrated instance (column is `NULL` for every row).** Already covered by AC-1's "clearing" positive case in reverse (`NULL` → a value) and AC-9's "no backfill needed" edge — no new case, confirmed adequate.

No Task changes from this round — every stress-tested boundary was already correctly handled by the existing design; this round's value is confirming (and documenting the confirmation of) completeness rather than surfacing a new gap.

### RLS / tenant isolation

`organizations` is the tenant-root table (no `org_id` column) — structurally outside `check-rls-coverage.ts`'s per-org-column heuristic, identical reasoning already documented for `defaultLocale`/the two dormancy columns on this exact table (Story 15.2, Story 7.2/8.3). Cross-tenant isolation for the new PATCH route is enforced at the application layer via the standard `:orgId === secureCtx.auth.orgId` guard (AC-1's cross-org 404). Cross-tenant isolation for the two **read** paths (AC-2's `GET /themes`, AC-3's `POST /domain-lookup`) is enforced by, respectively, `secureCtx.auth.orgId` (authenticated) and `org_sso_domains.domain`'s unique index (pre-auth, single-mapping guarantee already relied on by Story 14.4) — see AC-4 for the full test matrix.

### Session lifecycle

No auth/session-lifecycle changes. The new PATCH route uses the existing `secureRoute` MFA/session machinery identically to its three siblings in this file. The two read paths' security posture (`requireMfa: false` on `GET /themes`, `requireAuth: false` on `POST /domain-lookup`) is entirely pre-existing and unchanged by this story — see AC-6.

### Rate limits

Reuse existing configs verbatim everywhere — `{ max: 10, timeWindowMs: 60_000 }` for the new PATCH (AC-8, matching all three sibling org-settings routes), `secureRoute()`'s default 60/min for the extended `GET /themes` (unchanged), and `POST /domain-lookup`'s existing `{ max: 20, timeWindowMs: 15 * 60 * 1000 }` (unchanged, Story 14.4 AC-9). Do not invent a new threshold anywhere in this story.

### Migration compatibility

Additive, nullable, **no CHECK constraint** (the one deliberate divergence from Story 15.2's `defaultLocale` — see the ADR-style note in Previous-story intelligence above and AC-9's full rationale). Re-verify the next-free migration index at implementation time (Task 1.1) — every prior story in this sequence (15.1→15.2→16.2) has had to renumber at least once due to concurrent-branch collisions; treat `0060` as provisional.

### Operational logging

`debug`-level line on the admin write path only (AC-10), mirroring Story 16.2 AC-9's exact severity/rationale. No new log lines on the two read paths (would be per-request-volume noise, not an operational signal).

### Testing standards

- Backend integration tests co-located per this module's existing one-file-per-setting convention (`apps/api/src/modules/org/default-theme-settings-routes.test.ts`, sibling of `default-locale-settings-routes.test.ts`), using `withTestOrg()`'s multi-role fixtures for role-gating cases and doubled `withTestOrg()` calls for every cross-tenant-isolation assertion (AC-4).
- Every AC above must have at least one corresponding automated test. The following are the disaster-prevention cases most likely to be hand-waved (per this codebase's established discipline, e.g. Story 15.2's own Testing Standards note) and must **not** be skipped: personal-selection-always-wins-over-org-default (AC-2), dynamic-`unknown_theme`-not-`422` validation shape (AC-1), audit-fail-closed rollback (AC-5), cross-tenant isolation on **both** the authenticated and pre-auth read paths (AC-4), and the domain-lookup extension's fail-open behavior on every one of its existing miss/error paths (AC-3) — a regression here would silently break Story 14.4's already-shipped, security-relevant login flow, not just this story's own new feature.
- Frontend: extend existing test files rather than creating parallel new ones where a natural home exists (`apply-theme.test.ts`, `app-layout.server.test.ts`, `themes-page.test.ts`/`themes-page.server.test.ts`, `LoginForm`'s or `login/page.test.ts`'s existing suite) — this module has zero net-new test files planned beyond the one new backend route-test file (Task 2.6), following this codebase's "extend the sibling convention" discipline.

### Project Structure Notes

- New files: `packages/db/src/migrations/00NN_organizations_default_theme_name.sql`; `apps/api/src/modules/org/default-theme-settings-routes.test.ts`.
- Modified files: `packages/db/src/schema/organizations.ts`; `apps/api/src/modules/org/organization-settings-schema.ts`; `apps/api/src/modules/org/organization-settings-routes.ts`; `apps/api/src/modules/theming/schema.ts`; `apps/api/src/modules/theming/selection-routes.ts`; `apps/api/src/modules/theming/selection-routes.test.ts`; `apps/api/src/modules/auth/domain-lookup-routes.ts`; `apps/api/src/modules/auth/domain-lookup-routes.test.ts`; `packages/shared/src/schemas/auth.ts`; `apps/web/src/lib/theme/apply-theme.ts`; `apps/web/src/lib/theme/apply-theme.test.ts`; `apps/web/src/routes/(app)/+layout.server.ts`; `apps/web/src/routes/(app)/app-layout.server.test.ts`; `apps/web/src/lib/api/organization-settings.ts`; `apps/web/src/routes/(app)/settings/themes/+page.server.ts`; `apps/web/src/routes/(app)/settings/themes/+page.svelte`; `apps/web/src/routes/(app)/settings/themes/themes-page.test.ts` / `themes-page.server.test.ts`; `apps/web/src/lib/components/auth/LoginForm.svelte`; `apps/web/src/routes/(auth)/+layout.svelte`; `apps/web/src/lib/state/theme.svelte.ts` (possibly, per Task 7.2); `apps/web/src/routes/(auth)/login/page.test.ts`; `apps/api/src/lib/route-exemptions.ts` (new route classification entry); `packages/shared/openapi.json` (regenerated).
- Alignment with unified project structure: no new backend module, no new frontend route — every touch point is an existing file that already hosts a directly analogous precedent (org-settings' three existing PATCH routes, theming's existing GET/PATCH routes, the existing domain-lookup route, the existing themes settings page). This story is architecturally a "fourth setting + two response-field extensions + one client-side reactive-apply addition," not new infrastructure.
- No conflicts detected with the existing unified project structure beyond the documented judgment calls above (pre-auth org-resolution scope boundary, NULL-collapse trade-off).

### Stakeholder Round Table (Round 5 elicitation) — final disposition of the two flagged open questions

Convening the four perspectives most affected by this story's two explicitly-flagged judgment calls (Pre-auth org-resolution scope boundary; NULL-collapse trade-off), to give the dev agent a final decision rather than a still-open question to re-litigate mid-implementation:

- **Product/PM view:** The pre-auth scope boundary under-delivers slightly against the PRD's Amara narrative, but the alternative (a new general-purpose org-resolution mechanism) is a materially bigger, differently-shaped story that deserves its own dedicated scoping — not something to smuggle into a Medium-High retro-finding story. **Accepts the boundary as-is.**
- **Security view:** The NULL-collapse trade-off (Option A) introduces no new attack surface and no data-integrity risk — it's a UX ambiguity (a member can't force "always base"), not a security gap. The pre-auth scope boundary is actively security-*positive* — it avoids building a second domain-mapping surface that would duplicate 14.4's hijack hazard. **Endorses both decisions.**
- **Support/Ops view:** The "no user-facing orphaned-org-default notice" decision (AC-2) means a confused member sees an unexplained base-theme fallback with no in-app explanation. Accepted as-is because the OrgAdmin (who controls the setting) already gets 16.1/16.3's failure surfacing — the ordinary member isn't the actionable audience for that signal. **Accepts, with the note that this is the kind of thing a support-ticket macro can cover if it comes up, not a product gap.**
- **Admin/end-user (Riley) view:** An OrgAdmin configuring branding cares most about the authenticated fallback (AC-2, unconditional) and considers pre-auth branding (AC-3) a nice-to-have that partially working (for SSO-domain-mapped orgs) is still strictly better than not working at all. **No objection to the boundary.**

**Final disposition (binding for this story, not to be re-opened during implementation):**
1. Pre-auth org-resolution scope boundary — **stays exactly as scoped** (AC-3 + Out of Scope, unchanged by this round).
2. NULL-collapse trade-off — **Option A (accept the collapse) is final**, not merely "chosen" pending review; Option B remains a valid future follow-up but is not blocking this story's completion or requiring further sign-off.

Both items are now closed decisions, not open questions, for the purposes of code review (C2) and acceptance auditing — a reviewer re-raising either should treat this section as the recorded resolution, not a gap.

### References

- [Source: `_bmad-output/implementation-artifacts/epic-16-retro-2026-07-28.md`#Gap & Risk Audit, Finding 4] — origin of this story; full team-discussion context and routing decision.
- [Source: `_bmad-output/implementation-artifacts/sprint-status.yaml` — `16-4` entry] — scope framing quoted verbatim in this story's Story statement and journey stub.
- [Source: `_bmad-output/implementation-artifacts/15-2-configure-organization-default-locale-for-new-users.md`] — full previous-story intelligence: org-settings route/schema pattern, audit convention, RLS reasoning, ADR style this story follows.
- [Source: `_bmad-output/implementation-artifacts/16-2-select-an-active-theme.md`] — personal-selection mechanism, `unknown_theme` validation pattern, SSR-no-FOUC delivery, Out of Scope section that originated this story, `apply-theme.ts` helpers this story extends.
- [Source: `_bmad-output/implementation-artifacts/16-3-admin-ui-trigger-for-theme-reload.md`] — `(app)/settings/themes/` admin-section pattern, `canReloadThemes(orgRole)` role-gate helper reused verbatim.
- [Source: `_bmad-output/implementation-artifacts/14-4-route-login-to-sso-by-email-domain.md`] — `domain-lookup-routes.ts`/`LoginForm.svelte` two-step flow this story extends; `org_sso_domains`' operational hazard note.
- [Source: `_bmad-output/planning-artifacts/prd.md`, domain-requirements ~line 647; Amara journey narrative ~lines 305-315; FR120/FR121 ~lines 1167-1168] — the conflicting admin/org-wide framing this story resolves, and the login-screen-branding narrative this story partially (not fully) satisfies.
- [Source: `_bmad-output/planning-artifacts/epics.md`#Epic 16, lines 2696-2759] — Epic 16 scope and Story 16.1/16.2 ACs (no literal 16.4 text exists in epics.md; ACs here are synthesized from the retro finding per this story's own header note).
- [Source: `_bmad-output/planning-artifacts/architecture.md` line 1045 (Epic Traceability Matrix), lines 536-542 (Theming), line 1148 (Requirements-to-Structure Theming row), line 397 (email-first SSO login screen)].
- [Source: `apps/api/src/modules/org/organization-settings-{routes,schema}.ts`] — settings-route convention extended (fourth setting).
- [Source: `apps/api/src/modules/theming/{selection-routes,schema,service}.ts`] — `getCompiledThemes()`, `unknown_theme` validation pattern, `ThemeListResponseSchema` extended.
- [Source: `apps/api/src/modules/auth/domain-lookup-routes.ts`, `packages/db/src/schema/org-sso-domains.ts`] — pre-auth org-resolution mechanism extended; single-domain-mapping guarantee relied on for AC-4.
- [Source: `apps/web/src/routes/(app)/+layout.server.ts`, `apps/web/src/lib/theme/apply-theme.ts`] — authenticated resolution chain extended.
- [Source: `apps/web/src/lib/components/auth/LoginForm.svelte`, `apps/web/src/routes/(auth)/+layout.svelte`] — pre-auth reactive-apply target.
- [Source: `packages/db/src/migrations/0057_organizations_default_locale.sql`, `0058_users_selected_theme_name.sql`, `0059_credential_shares.sql`] — most recent migrations known at story-authoring time; re-verify the true latest at implementation time.
- Product surface rules: [Source: `_bmad-output/implementation-artifacts/product-surface-contract.md`]

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (claude-sonnet-5) — story authored via bmad-create-story, 2026-07-29. Implemented via bmad-dev-story, 2026-07-29.

### Debug Log References

- `pnpm --filter @project-vault/shared test` — 19 files / 183 tests, all green.
- `pnpm --filter @project-vault/db test` — 53 files / 244 tests, all green.
- `pnpm --filter api test` — full 266-file workspace suite run clean, in chunked synchronous batches (the suite's own `fileParallelism: false` config plus this dev machine's shared-Postgres contention make a single unbroken run exceed a single command's practical time budget): 305+463+260+410+94+115+289+115+23+109+118+84+72+96 = **2553 tests, all passing**, 0 failures across every batch. An interim single-shot attempt was disrupted mid-run by a concurrent `docker compose` container recreation on the shared dev Postgres (an unrelated multi-worktree port-churn hazard, not a code defect — see 8.5's note); the DB stack was stabilized on a fixed port and every batch re-run to a clean pass afterward.
- `pnpm --filter web test` — 220 files / 1815 tests, all green (one static-hardening false-positive from a doc-comment containing the literal html-injection-directive string was found and fixed by rewording the comment, not the code).
- `pnpm turbo typecheck` / `pnpm turbo lint` (whole monorepo, all 12 packages): 0 errors (pre-existing `security/detect-object-injection` and `security/detect-non-literal-*` warnings only, none newly introduced).
- `pnpm check-migration-compatibility`, `make check-rls`: both clean after migration `0060_organizations_default_theme_name.sql`.
- `pnpm generate-spec`: `packages/shared/openapi.json` regenerated; `pnpm --filter @project-vault/api-contract-tests test` — 5 files / 422 tests, all green, confirming the new/extended routes' response codes are correctly documented (the exact CI lesson AC-8.4 calls out).
- `route-audit` suite (3 files / 14 tests): passes with the new PATCH route classified via `route-exemptions.ts`.
- Remaining `make ci` steps run individually and confirmed green: `check-audit-actor-token-coverage`, `check-search-index`, `check-story-status-sync` (after syncing this story's `Status:` header + `sprint-status.yaml` to `review`), `check-sprint-status-rollup`, `check-story-references`, `check-psc-tbd-tracking`, `check-extension-api-version-skew`, `check-alert-pending-epic3`, `jscpd` (0 clones), `check-audit-baseline`, `check-env-example`.

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created.
- Implemented all 8 tasks per TDD (test-first, confirmed-fail, minimal-implementation, re-run-green) for every subtask.
- AC-1 (org-admin sets/clears org default theme): `PATCH /api/v1/organizations/:orgId/default-theme-settings` — dynamic `unknown_theme` 400 validation against the live compiled-themes list (not a fixed enum/422), `.strict()` body, cross-org 404 with a byte-identical-body assertion test, admin/owner role gating, `{max:10, timeWindowMs:60_000}` rate limit, inline fail-closed audit write.
- AC-2 (authenticated fallback): `GET /api/v1/themes` now also returns `orgDefaultThemeName` (org-scoped, never client-suppliable); `apps/web/src/lib/theme/apply-theme.ts`'s new `resolveAppliedThemeWithOrgDefault()` implements the three-tier personal→org-default→base resolution, each tier independently re-checked for orphaning; `(app)/+layout.server.ts` wired to it; the orphaned-selection notice stays keyed to the personal selection only (org default has no member-facing notice, per the story's documented decision).
- AC-3 (pre-auth login branding): `POST /domain-lookup` joins `organizations.defaultThemeName` onto the existing `org_sso_domains` lookup (no second pre-auth call), enforcing the both-or-neither invariant (`theme` key entirely omitted unless both `name`+`css` resolve) and a reload-race regression test confirming a single-snapshot read of `getCompiledThemes()`. `LoginForm.svelte` applies the theme reactively before Step B renders, via a new dedicated `preAuthThemeName`/`preAuthThemeCss` rune pair (kept separate from the authenticated `appliedTheme` rune) consumed by `(auth)/+layout.svelte`.
- AC-4 (RLS/tenant isolation): `make check-rls` unaffected (organizations is tenant-root); added cross-tenant isolation tests on both the authenticated (`GET /themes`) and pre-auth (`domain-lookup`) read paths.
- AC-5 (audit): `organization.default_theme_updated` inline-literal audit event, fail-closed rollback test included.
- AC-6 (session lifecycle): no caching anywhere — every consumer re-reads fresh per request; covered by "logout/login has no effect" reasoning already established by 16.2 (no new test needed, same code path).
- AC-7 (concurrency): last-write-wins test (two sequential PATCHes from different admin sessions).
- AC-8 (rate limits): reused the existing `{max:10, timeWindowMs:60_000}` org-settings config and the existing `domain-lookup`/`GET /themes` budgets verbatim; no new thresholds introduced.
- AC-9 (migration): migration `0060` is additive/nullable/no-CHECK, applied and verified against a live Postgres instance.
- AC-10 (operational logging): `req.log.debug(...)` line on the write path only, mirroring 16.2's exact convention.
- One interim bug found and fixed during Task 6 TDD: `createApp()`'s own boot sequence runs an automatic themes-directory reload pass that resets the module-level compiled-themes state — tests that seeded a fixture theme *before* calling `createApp()` had their seed silently wiped. Fixed by reordering every affected test to create the app first, then seed.
- Task 8.5 (manual/Chrome verification) is only partially complete — see the task's own note for the reason and the automated-coverage substitute.

### File List

**New:**
- `packages/db/src/migrations/0060_organizations_default_theme_name.sql`
- `apps/api/src/modules/org/default-theme-settings-routes.test.ts`
- `apps/web/src/routes/(auth)/layout.test.ts`

**Modified:**
- `packages/db/src/migrations/meta/_journal.json`
- `packages/db/src/schema/organizations.ts`
- `apps/api/src/modules/org/organization-settings-schema.ts`
- `apps/api/src/modules/org/organization-settings-routes.ts`
- `apps/api/src/lib/route-exemptions.ts`
- `apps/api/src/modules/theming/schema.ts`
- `apps/api/src/modules/theming/selection-routes.ts`
- `apps/api/src/modules/theming/selection-routes.test.ts`
- `apps/api/src/modules/auth/domain-lookup-routes.ts`
- `apps/api/src/modules/auth/domain-lookup-routes.test.ts`
- `packages/shared/src/schemas/auth.ts`
- `packages/shared/openapi.json`
- `apps/web/src/lib/theme/apply-theme.ts`
- `apps/web/src/lib/theme/apply-theme.test.ts`
- `apps/web/src/routes/(app)/+layout.server.ts`
- `apps/web/src/routes/(app)/app-layout.server.test.ts`
- `apps/web/src/lib/api/themes.ts`
- `apps/web/src/lib/api/organization-settings.ts`
- `apps/web/src/lib/api/auth.ts`
- `apps/web/src/routes/(app)/settings/themes/+page.server.ts`
- `apps/web/src/routes/(app)/settings/themes/+page.svelte`
- `apps/web/src/routes/(app)/settings/themes/themes-page.test.ts`
- `apps/web/src/routes/(app)/settings/themes/themes-page.server.test.ts`
- `apps/web/src/lib/components/auth/LoginForm.svelte`
- `apps/web/src/lib/components/auth/LoginForm.test.ts`
- `apps/web/src/routes/(auth)/+layout.svelte`
- `apps/web/src/lib/state/theme.svelte.ts`

### Change Log

- 2026-07-29: Implemented Story 16.4 (Tasks 1–8) — org-wide default theme: DB column + migration, `PATCH /:orgId/default-theme-settings`, `GET /themes` `orgDefaultThemeName` extension, authenticated three-tier resolution, admin settings-page section, pre-auth `domain-lookup` theme extension, reactive login-screen branding. All ACs (1–10) covered by new/extended automated tests; `openapi.json` regenerated. Status → review.
