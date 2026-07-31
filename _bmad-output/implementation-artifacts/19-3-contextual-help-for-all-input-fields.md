# Story 19.3: Contextual Help for All User-Facing Input Fields

Status: in-progress

## Story

As a person completing any Project Vault form,
I want every user-facing input, select, checkbox, radio group, and equivalent control to explain
what it controls and why it matters,
so that I can make informed decisions without guessing or consulting source code.

## Product Surface Contract

| Field | Value |
|-------|-------|
| **Surface scope** | `web` |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | See below |

### Persona journey stub

An authenticated project administrator visits a representative form containing a text field,
select, checkbox, and radio choice. Each visible control has a plain-language explanation directly
near it, the explanation is announced with the control through `aria-describedby`, and the copy
changes with the selected English/Spanish locale. The administrator can complete and submit the
form without validation, authorization, tenant, or audit behavior changing. QA also exercises the
same rule on an anonymous pre-auth control and a platform-admin control where those surfaces are
available in the local journey.

## Acceptance Criteria

1. **Deterministic inventory gate:** A repository check identifies every user-facing `input`,
   `select`, `textarea`, checkbox, radio group, and equivalent form control in `apps/web` and
   fails when a control lacks both visible explanatory text and an accessible relationship to that
   explanation. The check is deterministic, documented, runnable without network access, and
   wired into the existing Makefile/quality-gate path used before an epic closes. It must report
   file and line information and must not rely on an agent's memory or a manually maintained list
   of every passing control.
   - Exclusions are structural and explicit: hidden inputs, disabled template fragments, native
     `<option>` elements, display-only read-only values, and reusable option-only child components
     that do not render the control themselves are not treated as user-facing controls.
   - A suppression is allowed only for a documented, reviewed non-user-facing case and must name
     the reason; blanket file or directory suppressions are prohibited.
2. **Complete existing-form coverage:** Every in-scope control found by the inventory is updated
   with visible, localized, plain-language guidance describing what it controls, why it matters,
   or a meaningful trade-off. Existing explanations are retained where accurate and wired through
   `aria-describedby` (or an equivalent relationship); missing explanations are added through the
   existing Paraglide English/Spanish message system. No user-facing English literal is added as a
   shortcut.
   - Coverage includes controls in shared components and route forms, including vault setup and
     unseal flows, onboarding, auth/recovery, dashboards, credentials/import/rotation forms,
     machine users and members, audit/backups/platform settings, SSO/external identities,
     notification/theme/language settings, monitoring fields, and project/status forms.
3. **Meaningful copy and localization:** Each explanation is specific to the control's actual
   behavior and security trade-off, not a generic “enter a value” sentence. Copy accurately
   reflects tenant/project scope, secret exposure, caching, rotation, audit, notification,
   authentication, recovery, and destructive-operation behavior where applicable. English and
   Spanish messages are present, generated Paraglide output is refreshed, and switching locale
   does not discard entered values or change submission semantics.
4. **Accessibility and layout:** Every in-scope control has a stable, unique description ID (or
   equivalent accessible relationship), visible text is adjacent to the control it explains, and
   labels remain correctly associated. Help text works for text inputs, selects, textareas,
   checkboxes, radios, custom controls, and shared field abstractions; narrow viewport layouts do
   not clip, overlap, or hide the explanation. Invalid, disabled, loading, and conditionally
   rendered states preserve the association whenever the control is available.
5. **Security and behavior preservation:** This is a web presentation and quality-gate change.
   It must not alter API request bodies, validation rules, auth/session lifecycle, CSRF/redirect
   handling, tenant/RLS enforcement, authorization gates, audit-event emission/failure handling,
   rate limits, concurrency/replay protections, secret masking, or operational logging. Guidance
   must never interpolate secret values, tokens, raw server errors, another tenant's data, or
   attacker-controlled query text. Any behavior-affecting gap discovered during the audit is
   recorded as a separate follow-up rather than silently changed here.
6. **TDD and focused verification:** Tests are written first and fail for the missing-guidance
   behavior, then pass after implementation. Focused tests cover the deterministic inventory,
   representative control types, both locales, unique/valid `aria-describedby` wiring, conditional
   and shared components, and unchanged submit/value behavior. Only tests/typecheck/lint for
   affected web components and routes are required during this story; full local CI is deferred
   until all Epic 19 stories are complete.
7. **Playwright journey:** A real Playwright journey exercises representative authenticated and
   pre-auth surfaces at desktop and narrow viewport sizes, verifies that every rendered control in
   those journeys has visible localized help and a valid accessible relationship, switches locale
   while values are entered, and completes at least one form submission without changing its
   existing result. The journey must not expose another tenant's data or use real external
   services.
8. **Review and closure evidence:** The story records the inventory scope, structural exclusions,
   all intentional suppressions (if any), targeted test commands/results, Playwright result,
   security/accessibility review, and file list. Story status remains synchronized with
   `sprint-status.yaml`; the story may move to `done` only after code review finds no Critical or
   High issue and the inventory gate is green.

## Tasks / Subtasks

- [ ] Task 1: Complete a source and rendered-control inventory; reconcile contradictions between
  G5, existing Story 18.3's bounded floor, current route behavior, and shared components.
- [ ] Task 2: Add the deterministic red-phase inventory test/check and Makefile integration before
  adding missing help text; document structural exclusions and suppression policy.
- [ ] Task 3: Add localized explanations and accessible relationships to every in-scope shared
  component and route control, preserving existing behavior and avoiding duplicate IDs.
- [ ] Task 4: Add/update focused tests for representative controls, both locales, conditional
  branches, shared abstractions, and submit/value preservation.
- [ ] Task 5: Run targeted typecheck/lint/tests and a Playwright persona journey at desktop and
  narrow viewports; review tenant/RLS, audit/failure, auth/session, concurrency/replay, rate-limit,
  logging/metrics, migration/schema, and deployment implications.
- [ ] Task 6: Record evidence, perform adversarial review, synchronize status, and merge locally
  into `main` only after the story gate is green. Do not push remotely.

## Dev Notes

### Scope and constraints

- This story fulfills Epic 18 retrospective Finding 3 and deliberately expands Story 18.3's
  bounded contextual-help floor into the mandatory G5 audit for all existing user-facing controls.
- Use `FormHelpText.svelte` and the existing Paraglide runtime where practical; do not introduce a
  second i18n system or a broad form-component rewrite solely to make the audit pass.
- The checker should be conservative and reviewable. It may use a small parser/AST or a documented
  source convention, but it must not pass by simply ignoring a whole route or component.
- Generated Paraglide files must be refreshed through the repository's existing command, not hand
  edited.

### Required invariant review

- Tenant/RLS: guidance must not imply access beyond the current project/organization scope and must
  not reveal data while rendering conditional fields.
- Auth/session lifecycle: pre-auth guidance, recovery fields, MFA, and locale changes cannot create,
  bypass, or mutate a session; submit guards and redirects remain unchanged.
- Audit/failure behavior: adding explanations cannot suppress or replace existing audit events,
  safe error mapping, or operational failure reporting.
- Concurrency/replay: conditional controls and locale switches cannot duplicate requests or weaken
  existing single-submit/replay protections.
- Rate limits: no retry or validation behavior changes; controls remain subject to existing server
  limits.
- Schema/runtime compatibility: no API/DB schema or migration changes; generated message output
  must compile with the current runtime.
- Operational/deployment hardening: the gate runs deterministically offline and does not print
  secrets, tokens, environment values, or user data.

### Cross-story dependencies

- Depends on Story 18.3's `FormHelpText` pattern and Story 19.2's localized pre-auth shell/MFA.
- Story 19.4 separately addresses programmatic empty dependent-system validation; this story may
  add guidance to that form but must not implement its validation behavior.
- The Epic 19 retrospective must verify that the checker is maintained as new controls are added.

### Elicitation decisions integrated

1. **Boundary sweep:** include every rendered user-facing control, not merely the fields previously
   named by Story 18.3; exclude only structurally non-user-facing markup with an auditable reason.
2. **Security persona review:** treat tenant switching, anonymous auth/recovery, platform-admin
   settings, secret/caching choices, destructive actions, and attacker-controlled strings as
   explicit review paths.
3. **Accessibility review:** visible text, labels, unique IDs, `aria-describedby`, conditional
   rendering, keyboard behavior, and narrow layout are acceptance evidence, not optional polish.
4. **Architecture review:** enforce the invariant at a deterministic repository quality gate while
   reusing the existing lightweight help component and i18n boundary.
5. **Failure-mode review:** missing messages, duplicate IDs, hidden/conditional controls,
   malformed component markup, locale switching, disabled/loading states, and checker false
   negatives must be covered by tests or documented structural rules.

## References

- `_bmad-output/implementation-artifacts/epic-18-retro-2026-07-31.md` — Finding 3
- `_bmad-output/implementation-artifacts/product-surface-contract.md` — G5
- `_bmad-output/implementation-artifacts/18-3-sitewide-contextual-help-text-for-forms-and-sections.md`
- `apps/web/src/lib/components/forms/FormHelpText.svelte`
- `apps/web/messages/en.json`
- `apps/web/messages/es.json`

## Dev Agent Record

### Agent Model Used

Codex (GPT-5)

### Change Log

- 2026-07-31: Created from Epic 18 retrospective Finding 3. Planning included five elicitation
  rounds covering boundaries, security personas, accessibility, architecture, and failure modes;
  status set to ready-for-dev. No remote push authorized.
