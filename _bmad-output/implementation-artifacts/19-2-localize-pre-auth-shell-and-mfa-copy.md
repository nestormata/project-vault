# Story 19.2: Localize the Pre-Auth Shell and MFA Copy

Status: in-progress

## Story

As a person signing in, registering, or completing MFA before authentication,
I want every visible pre-authentication message to use my selected language,
so that the entire journey is understandable rather than switching back to English around the
localized form.

## Product Surface Contract

| Field | Value |
|-------|-------|
| **Surface scope** | `web` |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | See below |

### Persona journey stub

A Spanish-speaking person opens `/login`, sees the page title, heading, supporting copy, navigation
links, and form in Spanish, enters credentials, and if MFA is required sees the MFA label, help,
button, and failure/expiry messages in Spanish. A person opening `/register`, including an invitation
registration, sees the corresponding localized shell and can move between login and registration
without English copy appearing. Switching locale mid-flow preserves entered values and updates the
currently rendered shell and MFA copy.

## Acceptance Criteria

1. **Login shell localization:** the login route's document title, heading, supporting paragraph,
   account-registration link and accessible recovery link are Paraglide messages in English and
   Spanish. A reason/status message supplied by the route is localized too; unknown or absent
   reasons remain safe and do not expose raw server detail. No user-visible English literal remains
   in the login shell.
   - Positive: with locale `es`, `/login` renders `Iniciar sesión`, Spanish supporting text, and
     Spanish links; with locale `en`, the English equivalents render.
   - Edge: a `reason` value not in the allowlist renders no raw query-string text and does not
     break the page.
2. **Registration shell localization:** the registration route's title, heading, invitation and
   independent-organization descriptions, and link back to login are localized in both supported
   locales. Interpolation/branching remains semantically equivalent for invitation and non-
   invitation registrations.
   - Positive: invitation registration renders the Spanish invitation description; ordinary
     registration renders the Spanish independent-organization description.
   - Edge: missing/empty invitation token uses the ordinary branch and no untranslated branch text
     is emitted.
3. **MFA localization:** every visible string owned by `MfaLoginForm.svelte` is localized, including
   the authenticator-code label, explanatory help, expired-token error, invalid-code error,
   generic verification error, verifying state, and verify action. The existing six-digit input
   constraint, autocomplete, submit guard, token expiry behavior, and error clearing are unchanged.
   - Positive: the MFA challenge in Spanish shows Spanish label/help/action and an invalid code
     shows the Spanish error.
   - Edge: expired token clears the challenge and shows the Spanish restart message; a non-Error
     failure shows the localized generic message rather than an English fallback.
4. **Locale consistency and state preservation:** the shell and MFA components use the same
   Paraglide runtime/messages as the existing auth forms. Changing locale without a full navigation
   updates visible shell/MFA strings immediately and preserves email, password/SSO credential,
   TOTP input, current step, and the existing error/status state. No locale is accepted from an
   unauthenticated API mutation and no auth/session, redirect, CSRF, or tenant behavior changes.
   - Positive: type an email and TOTP, switch from English to Spanish, and verify values remain and
     the labels update.
   - Edge: switch locale while an MFA verification request is pending; the in-flight request is not
     duplicated or bypassed, and the single-submit guard remains active.
5. **Accessibility and responsive behavior:** localized text remains associated with its controls,
   links remain keyboard reachable, document titles are localized, and narrow viewports do not
   clip or hide the shell navigation or language switcher. Every new/changed input field has a
   visible explanation connected with `aria-describedby` when an explanation is needed under G5.
6. **Test and journey evidence:** TDD red-green tests cover both locales, invitation/non-invitation
   shell branches, every MFA success/error/expiry copy path, locale switching with state
   preservation, invalid/unknown reason handling, and accessibility associations. A Playwright
   journey exercises the real `/login` and `/register` pages at desktop and narrow viewport sizes,
   switches locale, and validates the localized shell plus MFA challenge behavior without exposing
   another tenant's data. Run only focused web tests/typecheck/lint and the story's Playwright
   journey during this story; full local CI is deferred until all Epic 19 stories are complete.

## Tasks / Subtasks

- [ ] Task 1: Audit the login/register route shells and enumerate every visible English literal,
  including status/reason branches and invitation copy.
- [ ] Task 2: Add English/Spanish Paraglide messages and replace shell literals while preserving
  safe reason allowlisting, redirects, query handling, and invitation semantics.
- [ ] Task 3: Localize all MFA labels, help, actions, and error/fallback paths without changing
  authentication control flow or the six-digit validation contract.
- [ ] Task 4: Add/extend focused component and route tests using TDD red-green, including G5
  explanations and state preservation.
- [ ] Task 5: Run targeted review for tenant/auth/session/rate-limit/logging implications and
  execute the Playwright persona journey at desktop and narrow viewports.
- [ ] Task 6: Record evidence, file list, review findings, status transition, and no-remote-push
  disposition; merge locally into `main` only after targeted gates pass.

## Dev Notes

### Scope and constraints

- Story 18.11 already added the pre-auth language switcher and localized form fields. This story
  closes only its explicitly recorded review deferral: the surrounding route shells and
  `MfaLoginForm.svelte` remain English.
- Reuse `$lib/paraglide/messages.js` (`m`) and the existing runtime locale mechanism. Do not add a
  second i18n system, accept locale through registration/login API bodies, or weaken auth guards.
- Inspect generated Paraglide output after editing message JSON; use the repository's existing
  generation command rather than hand-editing generated files.
- This is web-only: no API route, DB schema, migration, audit event, RLS policy, or rate-limit
  behavior should change. If implementation reveals a security-relevant server change is needed,
  stop and record it for separate review rather than expanding this story silently.

### Required invariant review

- Tenant/RLS: route copy must not interpolate org/user data beyond already-authorized values; the
  `next` path remains same-origin constrained.
- Auth/session lifecycle: login, registration, MFA token expiry, MFA retry, and post-auth redirect
  semantics remain unchanged; locale switching must not create or bypass a session.
- Audit/failure behavior: localized client rendering must not suppress existing auth errors or
  logging; raw server errors remain governed by current safe mapping.
- Concurrency/replay: preserve the MFA submit guard and locale-switch race handling; no duplicate
  verification request on double interaction.
- Operational and deployment hardening: no secret, credential, token, raw MFA code, or internal
  exception should enter copy keys, telemetry, snapshots, or client logs.
- Input explanations: any newly touched input must retain or add an accessible visible explanation
  per G5; the six-digit MFA explanation is part of the story's acceptance evidence.

### Cross-story dependencies

- Depends on Story 18.11's `PreAuthLanguageSwitcher` and localized auth-form message keys.
- Independent of Stories 19.1, 19.3, and 19.4 at implementation level.
- Epic 19 retrospective must verify no pre-auth English literals or untracked localization
  deferrals remain after this story.

### Elicitation decisions integrated

1. **Boundary sweep:** inventory all shell branches, reason values, invitation states, MFA failure
   classes, narrow layouts, and no-JS/SSR title behavior; these are explicit ACs rather than happy
   path assumptions.
2. **Security persona review:** anonymous visitor, attacker-controlled `reason`/`next`, expired
   MFA token, and a user switching locale during an in-flight request must retain safe output and
   existing auth controls.
3. **Accessibility review:** labels, visible explanations, document titles, keyboard navigation,
   and narrow viewport wrapping are explicit evidence requirements.
4. **Architecture review:** keep locale concerns in Paraglide message/runtime boundaries and avoid
   changing the server auth contract; no new endpoint or persistence path is justified.
5. **Failure-mode review:** unknown reason, invitation branch drift, invalid TOTP, expired token,
   generic exception, and locale-switch race each require localized deterministic behavior.

## References

- `_bmad-output/implementation-artifacts/18-11-pre-login-and-registration-language-selection.md`
- `apps/web/src/routes/(auth)/login/+page.svelte`
- `apps/web/src/routes/(auth)/register/+page.svelte`
- `apps/web/src/lib/components/auth/MfaLoginForm.svelte`
- `apps/web/src/lib/components/auth/LoginForm.svelte`
- `apps/web/src/lib/components/auth/RegisterForm.svelte`
- `apps/web/src/lib/security/hardening.ts`
- `apps/web/messages/en.json`
- `apps/web/messages/es.json`
- `_bmad-output/implementation-artifacts/product-surface-contract.md`

## Dev Agent Record

### Agent Model Used

Codex (GPT-5)

### Implementation Plan

To be completed during implementation.

### Debug Log References

To be completed during implementation.

### Completion Notes List

To be completed during implementation.

### File List

To be completed during implementation.

### Change Log

- 2026-07-31: Created from Epic 18 Finding 1 / Story 18.11 review deferral with five elicitation
  rounds integrated; status set to ready-for-dev. No remote push authorized.
