# Story 18.11: Pre-Login and Registration Language Selection

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a new user registering, or anyone on the login page, before I'm authenticated,
I want to pick my language right there,
so that I'm not stuck reading English until I dig through settings after logging in; and as an existing user, when I do change my language preference, I want the UI to actually reflect it everywhere.

## Product Surface Contract

| Field | Value |
|-------|-------|
| **Surface scope** | `web` |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | See below |

### Persona journey stub

A new user lands on the registration page, switches the language to Spanish using a visible language switcher, fills out the form in Spanish, and their account is created with `locale='es'` from the start — no trip to settings required afterward. An existing user on the login page can likewise switch language before authenticating. A user who changes their language in settings sees the whole app (not just the settings page itself) reflect the new language on the very next navigation.

## Acceptance Criteria

1. **Scope correction from the raw feedback**: i18n plumbing already exists and is substantially built — `@inlang/paraglide-js` is wired (`apps/web/src/lib/paraglide/`), `users.locale` exists in the DB (`packages/db/src/schema/users.ts:23`, default `'en'`, `CHECK IN ('en','es')`, per Story 15.1), SSR locale resolution is wired in `apps/web/src/hooks.server.ts` (`paraglideMiddleware`, `PARAGLIDE_LOCALE` cookie), and a working language switcher already exists at `apps/web/src/routes/(app)/settings/language/+page.svelte`. This story does **not** rebuild i18n — it (a) investigates and fixes the specific "changing language doesn't actually apply" complaint if reproducible, and (b) adds language selection to the pre-authentication surfaces (login, registration) where none exists today.
2. Investigate the "If I change my language the UI still shows in English" complaint against the actual current behavior of `apps/web/src/routes/(app)/settings/language/+page.svelte` and `hooks.server.ts`'s `PARAGLIDE_LOCALE` cookie handling. Reproduce it with a real before/after check (change language, navigate to at least 2 other pages, confirm rendered language). Document the actual finding in Dev Agent Record: either (a) a genuine bug is found and fixed (with a regression test), or (b) the behavior is confirmed already correct today and this AC is marked verified-no-bug-found with the reproduction steps used, so the story doesn't claim a fix that wasn't needed.
3. `apps/web/src/lib/components/auth/LoginForm.svelte` and `RegisterForm.svelte` (confirmed to currently have no locale references at all) gain a visible language switcher, reusing the existing `setLocale` mechanism from `$lib/paraglide/runtime.js` (same primitive the settings-page switcher already uses) rather than inventing a new locale-switching mechanism. The switcher uses the same control type as the existing settings-page switcher (not a different UI pattern for the same action), shows a text label (not icon-only/flag-only, which is ambiguous and inaccessible), and its placement/behavior on narrow viewports is considered, not left unspecified. Switching language does not discard any form input already typed on the login/register form (verify field values survive the `setLocale` call, consistent with AC-5).
4. **Important existing-guard conflict, resolved explicitly**: `apps/api/src/modules/auth/service.ts` (`registerUser`, ~lines 472-478) currently seeds a new user's `locale` from the org's `defaultLocale` with an explicit code comment that it must **never come from client input** (Story 15.2 AC-2's deliberate security/consistency decision). This story does **not** override that guard. Instead, the selected pre-auth language is applied via the existing client-side `setLocale` (`PARAGLIDE_LOCALE` cookie) for immediate rendering during registration, and — after the account is successfully created — the new user's `users.locale` is updated via a separate, authenticated follow-up call that reuses the existing settings-page `?/updateLocale` action/mechanism (the same one AC-2 investigates), not by threading a `locale` field into `registerUser` itself. This keeps Story 15.2's guard intact while still achieving "the account ends up with the chosen locale, no later settings trip required." Confirm and state explicitly whether registration auto-authenticates the new user (session established immediately) before this follow-up call fires — if it does not, specify how the follow-up call authenticates (e.g. deferred until first authenticated request/login) rather than assuming a session is already available.
5. The pre-auth (login/register) language switcher changes the rendered UI language immediately (client-side, via `setLocale`) without requiring a page reload that loses form input, consistent with how the existing settings-page switcher already avoids/handles this (reuse its approach, including its documented double-click-race handling). Switching language mid-login (e.g. after a failed login attempt, with an error message already displayed) preserves the currently-shown form state/error rather than resetting it.
6. If the AC-4 follow-up call to persist `users.locale` after registration fails (e.g. transient network error) while account creation itself succeeded, this must not be treated as a registration failure — the account exists either way; the locale-persistence failure is a soft, non-blocking follow-up (the user can still change it later in Settings), and the failure is logged for support triage. This failure mode is covered by a test.
7. Any locale value submitted directly to a locale-setting action (bypassing the UI dropdown) that isn't in the `CHECK IN ('en','es')` set is rejected with a clean validation error at the API layer, not surfaced as a raw DB constraint violation/500.
8. New/updated tests cover: registration completes and the chosen locale is persisted via the AC-4 follow-up mechanism, the pre-auth switcher changes rendered strings without losing form input, the AC-6 non-blocking-failure behavior, the AC-7 invalid-locale rejection, and (if AC-2 finds a real bug) the specific reproduction is covered by a regression test.

## Tasks / Subtasks

- [ ] Task 1: Investigate and resolve (or confirm non-issue) the "language change doesn't apply" complaint (AC: 2)
- [ ] Task 2: Add language switcher to LoginForm/RegisterForm, matching existing switcher UX (AC: 3, 5)
- [ ] Task 3: Wire post-registration locale persistence without touching `registerUser`'s client-input guard (AC: 4, 6, 7)
- [ ] Task 4: Tests (AC: 8)

## Dev Notes

- **This is smaller in scope than "add i18n"** — i18n itself (Story 15.1 and related) is already shipped. Re-verify this claim (`apps/web/src/lib/paraglide/`, `users.locale` column, `hooks.server.ts`) before starting, since it significantly narrows what this story needs to build.
- **Critical: do not modify `registerUser`'s locale-sourcing to accept client input.** `apps/api/src/modules/auth/service.ts` (~lines 472-478) deliberately sources `locale` from `org.defaultLocale`, with an explicit "never from client input" comment tied to Story 15.2 AC-2. This story's original draft assumed extending the registration action to accept a `locale` field directly was "a small, additive change" — it is not; it would reverse a previous story's deliberate guard rail. Use the two-step approach in AC-4 instead (immediate client-side `setLocale` for rendering + a separate authenticated post-registration persistence call) so Story 15.2's decision stays intact.
- Existing switcher to model from: `apps/web/src/routes/(app)/settings/language/+page.svelte` — uses `setLocale` from `$lib/paraglide/runtime.js`, a form action `?/updateLocale`, and explicitly handles a double-click race by trusting the server response over the optimistically-clicked value (inline comment references "AC 2 double-click race" — this is the *other* known double-click bug in this codebase, distinct from Story 18.4's toggle-button issue; don't conflate the two, but do reuse this file's race-handling pattern here since it's directly relevant to a pre-auth switcher too, and reuse the same `?/updateLocale` action for the post-registration persistence call in AC-4 rather than building a new endpoint).
- `LoginForm.svelte`/`RegisterForm.svelte` currently have zero locale references — this is new UI, not a fix to existing broken UI.

### Project Structure Notes

- No new i18n infrastructure, no new DB columns/migrations expected — this should be achievable entirely within `apps/web/src/lib/components/auth/`, the registration route/action, and reuse of existing `$lib/paraglide/runtime.js` primitives.

### References

- [Source: apps/web/src/lib/paraglide/]
- [Source: packages/db/src/schema/users.ts#locale]
- [Source: apps/web/src/hooks.server.ts]
- [Source: apps/web/src/routes/(app)/settings/language/+page.svelte]
- [Source: apps/web/src/lib/components/auth/LoginForm.svelte]
- [Source: apps/web/src/lib/components/auth/RegisterForm.svelte]
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]

## Dev Agent Record

### Agent Model Used

### Debug Log References

### Completion Notes List

### File List
