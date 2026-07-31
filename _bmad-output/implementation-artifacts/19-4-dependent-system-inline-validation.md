# Story 19.4: Inline Validation for Empty Dependent-System Submissions

Status: in-progress

## Story

As a credential administrator,
I want the dependent-system form to explain when its required system name is missing,
so that a programmatic or keyboard submission gives me actionable feedback instead of silently
doing nothing.

## Product Surface Contract

| Field | Value |
|-------|-------|
| **Surface scope** | `web` |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | An authenticated project administrator opens a credential's dependent-system disclosure, submits whitespace-only System name, sees localized inline guidance, corrects it, and successfully adds a dependent system. |

## Context and scope

Story 2.9's review found that `onAddDependency` trims `depSystemName` and returns when the result
is empty, but does not set `depError`. Browser-native `required` validation covers ordinary pointer
submission, while a programmatic submit or a browser path that bypasses native validation silently
does nothing. Story 18.7 subsequently made this form a collapsed `<details>` disclosure, and Story
19.3 added the required contextual help and accessible relationships. This story adds only the
missing client-side inline validation; it does not change the API contract or server validation.

In scope:

- Set a localized, field-associated inline error when the trimmed System name is empty.
- Keep the disclosure open, retain the other entered values, avoid an API call, and allow a
  corrected retry.
- Preserve existing success, archived-project, dependency-limit, URL, field-key, authorization,
  audit, and rate-limit behavior.

Out of scope:

- Changing dependent-system API schemas, server validation, database migrations, or audit events.
- Replacing browser-native validation or adding a second validation framework.
- Validating optional Notes, Link URL, or field scope beyond their existing server/client behavior.

## Acceptance Criteria

### AC1 — Empty and whitespace-only names produce inline feedback

Given an authorized user has opened the Add dependent system disclosure, when `System name` is
empty or contains only whitespace and the submit handler is invoked programmatically or through a
native form submit path that reaches the handler, then:

- no `addCredentialDependency` request is made;
- the trimmed value is not submitted or logged;
- an inline localized error is rendered adjacent to the System name field;
- the error is announced through the field's existing accessible relationship (for example,
  `aria-describedby` includes a stable error ID in addition to the help ID, or an equivalent
  `aria-errormessage` relationship); and
- the disclosure remains open so the user can correct the field.

Positive example: submitting `"   "` renders “Enter a system name.” below System name and leaves
Notes, Link URL, and field scope unchanged.

Failure/edge examples: an empty string and a string containing tabs/newlines are both rejected;
clicking submit repeatedly while the error is visible does not issue a network request or create
duplicate error nodes.

### AC2 — Corrected retry preserves existing successful behavior

After AC1, when the user enters a non-empty name and submits, the existing add-dependent-system
request is made once with the trimmed name and the existing optional fields. On success, the new
row appears, the form fields reset exactly as before, and the inline empty-name error is removed.

Positive example: `"  Payroll API  "` submits `"Payroll API"`, adds the returned dependency, and
clears the form.

Failure/edge examples: a server error still uses the existing `depError`/`depBanner` handling and
does not get replaced by the local empty-name error; a second submit while the request is pending
still observes the existing `depSubmitting` guard.

### AC3 — English and Spanish copy is localized and safe

The new error uses the existing Paraglide message boundary with English and Spanish translations.
Switching locale before submitting displays the selected locale's message without exposing the
entered name, URL, notes, token, server exception, or attacker-controlled text. Existing form
values and submission semantics survive the locale change.

Positive example: in Spanish, whitespace-only submission displays a Spanish required-name message.

Failure/edge examples: the message key is present in both locale catalogs; a name containing HTML,
quotes, or control characters is never interpolated into the error as markup.

### AC4 — Accessibility and layout remain valid

The error is visible, has a stable unique ID, is associated with `System name`, and remains usable
when the disclosure is expanded at desktop and narrow viewport widths. Labels, contextual help,
keyboard submission, focus behavior, and the existing disabled/loading states remain intact.

Positive example: a screen-reader-style DOM inspection finds the System name label, help text, and
error text as associated descriptions after the failed submission.

Failure/edge examples: opening/closing/reopening the disclosure does not leave duplicate IDs;
successful retry removes the stale error association; the error does not overlap the input on a
375px-wide viewport.

### AC5 — Security and behavior invariants are unchanged

No API request body, route, schema, migration, tenant/RLS context, authorization gate, auth/session
lifecycle, CSRF/redirect handling, audit event, failure audit behavior, rate limit, concurrency
guard, retry policy, secret masking, or operational logging behavior changes. The local check is
performed before any network call and does not reveal dependent systems from another tenant.

Relevant verification includes: authorized owner/member behavior follows the existing gate;
archived projects still use the existing 410 banner; unauthorized users cannot reach the form;
repeated submissions cannot bypass `depSubmitting`; and the server remains the source of truth for
all non-empty-name validation and persistence.

### AC6 — TDD and focused verification

Tests are written first and fail for the missing inline-error behavior. Focused tests cover empty,
whitespace, corrected retry, no-request behavior, duplicate-submit protection, error clearing,
English/Spanish message selection, and preserved optional-field values. Run only affected web tests,
typecheck, lint, and the deterministic form-guidance check during this story; full local CI is
deferred until all Epic 19 stories are complete.

### AC7 — Playwright persona journey

A Playwright journey uses a local authenticated project/credential and exercises the real browser
form at desktop and narrow viewport sizes. It submits whitespace-only System name, verifies the
visible localized inline error and its accessible association, switches locale while values are
entered, corrects the name, submits successfully, and verifies the new dependent-system row. No
real external service or cross-tenant data is used.

### AC8 — Evidence and closure

The story records the implementation plan, focused test commands/results, Playwright result,
security/accessibility review, changed files, and any separately deferred behavior. Its `Status:`
header must remain synchronized with `sprint-status.yaml`. It may move to `done` only after review
finds no Critical or High issue and the focused gates are green.

## Implementation Notes

- Reuse the existing `depError` state and `FormHelpText`/Paraglide patterns in
  `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte`.
- The smallest expected change is to replace the silent empty-name return in `onAddDependency` with
  a localized field error and to render/associate that error in the existing form.
- Do not add a server call, schema change, migration, new global validation utility, or changes to
  other dependent-system operations.
- The current `required` attribute remains useful for ordinary browser validation; the explicit
  handler guard is required for programmatic submission and test coverage.

## Cross-story dependencies

- Depends on Story 2.9's existing credential/dependent-system form and API behavior.
- Depends on Story 18.7's disclosure and Story 19.3's contextual-help/accessibility contract.
- Completes the review deferral routed by the Epic 18 retrospective and enforced by
  `check-story-review-deferrals`.

## Elicitation and review decisions

1. **Boundary pass:** keep the fix to the one silent client-side return identified in Story 2.9;
   optional-field validation and server-side contracts remain explicitly out of scope.
2. **Security-persona pass:** verify tenant/authorization, archived-project, rate-limit, audit,
   and secret-handling invariants rather than treating this as a purely cosmetic error.
3. **Accessibility pass:** require a stable error relationship, visible text, duplicate-ID safety,
   keyboard submission, disclosure state, and narrow-layout evidence.
4. **Architecture pass:** reuse existing `depError`, Paraglide, and page-local patterns; avoid a
   new validation abstraction for one field.
5. **Failure-mode pass:** cover programmatic submit, whitespace, repeated submit, locale changes,
   server failure after correction, disclosure reopen, and no-network-call behavior.

## Dev Agent Record

### Agent Model Used

Codex (GPT-5)

### Change Log

- 2026-07-31: Created from the Epic 18 retrospective review-deferral guard and Story 2.9's
  unchecked Medium finding. Planning and adversarial review were performed locally by Codex; no
  remote push is authorized.
