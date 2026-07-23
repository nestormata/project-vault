# Story 12.2: Usability Trust and Accessibility Fixes

Status: done

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

<!-- Ad-hoc, audit-driven story with no epics.md entry — epic-12 was registered directly from
     docs/usability-audit-2026-07-13.md (own live-browser navigation + independent UX-expert and
     accessibility-expert subagent reviews + product-owner findings), same precedent as epics 6-5,
     1-14, 1-15, 11. This story is a split of the original bundled story
     `12-1-usability-and-navigation-fixes` (now removed) — it carries AC groups B-E: first-run
     dashboard-staleness trust bug, onboarding escape hatch, sealed-vault explanation, accessibility
     fixes, and naming/content consistency. The sibling split,
     `12-1-project-information-architecture`, covers the project-overview-page/persistent-sub-nav
     rework and is fully independent of this story — a developer can implement either split without
     reading the other. -->

## Story

As an org owner, admin, or member using Project Vault day to day,
I want the app's first-run experience, sealed-vault messaging, accessibility, and user-facing naming
to be trustworthy and coherent,
so that a security/operations product I depend on doesn't itself create confusion, distrust, or
exclusion for the people using it.

## Background (read this before starting — do not skip)

Full findings, rationale, and severity ranking live in `docs/usability-audit-2026-07-13.md`. This
story implements the UX-expert findings #1, #3, #4, #6, #7, #8, #9, and #13, plus the
accessibility-expert's corresponding findings and product-owner finding P4. Confirmed via direct
source read (2026-07-13, this worktree):

- **Dashboard staleness (B).** `apps/web/src/routes/(app)/dashboard/+page.server.ts` calls
  `listProjects`, `getOrgDashboard`, `getProjectDashboard` on every load via SvelteKit's server
  `load` — this *should* be fresh on navigation, but the reported bug is that right after the
  onboarding wizard's final step, the dashboard renders stale/empty data. The likely cause is a
  client-side route transition (`goto`) after the wizard completes that reuses a cached load result
  instead of forcing a fresh server round-trip, or a race between the wizard's final mutation and
  the dashboard's `load` firing before the write is durably visible. Locate the wizard's completion
  handler in `apps/web/src/lib/components/onboarding/OnboardingWizard.svelte` /
  `onboarding-logic.ts` and trace exactly how it transitions to `/dashboard` before fixing.
- **Onboarding escape hatch (B).** `apps/web/src/lib/components/onboarding/OnboardingDialog.svelte`
  (confirmed, full file read) renders `role="dialog" aria-modal="true"` with a `trapFocus` effect but
  **has no close/skip button in its markup at all**, and has no `keydown`/Escape handler — Escape
  does nothing. This is the literal root cause of audit finding UX-4 and the corresponding
  accessibility "High" finding.
- **Sealed vault (C).** `apps/web/src/lib/components/vault/gate-model.ts` (confirmed, full file
  read): for `readiness.state === 'sealed'`, `title` is a static `'Unseal vault'` and `message` is
  whatever the **API** returns as `readiness.message` — there is no static, in-product explanation
  of what "sealed" *means* (envelope encryption locked / master key not currently in memory)
  anywhere in the web layer; whatever explanatory copy exists is entirely dependent on what the API
  happens to send, which this story should not assume is adequate.
- **Destructive actions (D).** `apps/web/src/routes/(app)/settings/users/+page.svelte` (confirmed,
  lines ~420-495): "Deactivate account," "Send recovery link," "Remove from organization," "Request
  erasure," and "Pseudonymize identity" are all rendered as plain underlined text buttons
  differentiated only by text color (`amber-700`, `slate-700`, `red-700` — i.e., **color alone**,
  the exact WCAG 1.4.1 violation the audit flagged) stacked in one `flex flex-col` list with no
  grouping/divider/icon. `onDeactivateOrgUser` already calls a native `confirm(...)` dialog with the
  user's email in the message — confirmation exists for deactivate; verify whether "Remove from
  organization" and "Request erasure" have equivalent confirmation before assuming they don't.
- **Notification preferences row labeling (D).** `apps/web/src/routes/(app)/settings/notifications/+page.svelte`
  (confirmed, lines 78-93, 121-129): real `<select name="frequency">` and `<select name="minSeverity">`
  elements per row, **no `aria-label`/`aria-labelledby`** on any of them.
- **404 page (D).** No `apps/web/src/routes/+error.svelte` exists anywhere in the app (confirmed via
  full-tree search) — SvelteKit's default bare/unstyled error page renders for any unmatched route,
  with zero landmarks, zero branding, zero way back.
- **Naming/content (E).** `apps/web/src/routes/(auth)/register/+page.svelte` line 20 (confirmed):
  `'Create the first organization account for this vault.'` renders unconditionally regardless of
  whether other orgs already exist. The "Alerts" nav item (`nav-model.ts`: `{ label: 'Alerts',
  href: '/notifications' }`) points at a route titled "Notifications" — confirm the actual rendered
  `<h1>`/heading text on `apps/web/src/routes/(app)/notifications/+page.svelte` before fixing, since
  the mismatch could be resolved from either direction (rename the nav label to "Notifications," or
  rename the page heading to "Alerts" — this story's AC leaves that choice to the dev agent but
  requires them to match).

**This story does not need `docs/usability-audit-2026-07-13.md` or the sibling
`12-1-project-information-architecture` story to be understood or implemented — everything required
is in this file.**

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `web` |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | See below |

### Persona journey stub

Riley-admin finishes the 3-step onboarding wizard, creating an org, a first project, and a first
credential. The wizard's final step transitions to `/dashboard`. The dashboard immediately shows
"1 project" and "1 credential" — not a stale "no projects saved yet" state requiring a manual
reload. Separately, Alex-viewer joins an org that already has 6 projects; the onboarding wizard does
not force-fire for Alex, or if it does, Alex can press Escape or click a visible "Skip for now"
control to dismiss it and reach the dashboard directly. Later, an operator restarts the Docker stack
and the vault comes back sealed; visiting the app shows an unseal form accompanied by plain-language
copy explaining that "sealed" means the vault's encryption key is not currently loaded into memory
and a passphrase is needed to unlock it — not a bare form with zero context. Meanwhile, Morgan-owner
opens Settings → Users and can visually tell at a glance which actions are destructive (Deactivate,
Remove, Request erasure) versus safe (Send recovery link) without relying on color alone, and gets a
confirmation naming the specific user before any destructive action executes. A screen-reader user
tabbing through Settings → Notifications hears each row's frequency/severity controls announced with
that row's specific alert type and channel, not "combobox, Immediate" repeated with no context. A
user who mistypes a URL lands on a branded 404 page with a link back to the dashboard, not a bare
white page. Throughout Notifications settings and the Audit log, event types render as consistent
human-readable labels (e.g. "Backup failure") rather than a mix of `audit_storage.critical`,
"Backup Failure", and `SESSION_CREATED` in the same table.

## Acceptance Criteria

### B — First-run trust and reliability

1. **Dashboard reflects freshly-created data immediately after onboarding (happy path).** A user
   completing the onboarding wizard (org + first project + first credential created in the wizard's
   3 steps) is transitioned to `/dashboard` such that the dashboard's project count, credential
   count, and project list show the just-created data on first render — no stale "0
   credentials"/"no projects saved yet" state, and no manual reload required to see correct data.
2. **Root-cause verification, not a band-aid.** Trace the actual transition mechanism the wizard
   uses to reach `/dashboard` (in `OnboardingWizard.svelte`/`onboarding-logic.ts`) and identify
   whether the bug is (a) a client-side `goto()` reusing a stale `load` result, (b) a race between
   the wizard's last mutation's response and the dashboard's server `load` firing too early, or (c)
   query/cache invalidation that isn't wired up. Fix the actual mechanism (e.g. `goto(url, {
   invalidateAll: true })`, or awaiting the mutation's durable-write confirmation before navigating,
   or a hard navigation) — do not paper over it with a client-side polling loop or an artificial
   delay.
3. **Slow backend edge case.** If the org/project/credential creation calls in the wizard are slow
   (simulate via a delayed mock in the test), the dashboard transition must not fire before the
   creation calls have resolved — i.e., the fix must not just narrow the race window, it must
   eliminate it. Add a test that asserts the dashboard load only proceeds after the wizard's mutation
   promises settle.
4. **Failure edge case.** If the wizard's final mutation fails (e.g. project creation 500s after the
   org was already created), the wizard does not silently transition to a dashboard that then shows
   an inconsistent partial state (org created, project missing) with no explanation — surface the
   error in the wizard itself (existing error-handling pattern in `OnboardingWizard.svelte`, if any,
   should be reused; if none exists, add a minimal inline error message) rather than transitioning
   away from the point of failure.
5. **Onboarding modal has a visible close/skip control (happy path).** `OnboardingDialog.svelte`
   renders a close button (e.g. an "×" icon button, `aria-label="Close"` or "Skip for now" text
   button) visible on every step, not just conceptually reachable via some other flow. Clicking it
   closes the dialog and leaves the user on whatever page was behind it (or navigates to
   `/dashboard` if no sensible "behind" page exists — match whatever the app's other dismissible
   modals already do, if any exist; otherwise default to `/dashboard`).
6. **Escape key closes the modal.** With focus trapped inside `OnboardingDialog` (per the existing
   `trapFocus` behavior), pressing Escape closes the dialog, consistent with standard modal keyboard
   behavior (this is the direct fix for the audit's "No Keyboard Trap in spirit" finding). Add a
   `keydown` listener scoped to the dialog (or a document-level listener gated on the dialog being
   open) that calls the same close handler as the visible close button in AC-5.
7. **Escape/close does not fire mutations.** Dismissing the dialog via Escape or the close button at
   any step (including mid-step-2, after step 1's data may have already been saved via an API call)
   does not trigger any additional writes, and does not delete/roll back what was already saved in
   completed steps — verify against `onboarding-logic.ts`'s actual step-commit behavior (if each
   step commits incrementally via its own API call, a partial completion is expected and acceptable;
   confirm this is already the existing behavior and that closing early doesn't corrupt it).
8. **Wizard does not force-fire for a user joining an already-set-up org.** A second admin/owner
   accepting an invitation into an org that already has ≥1 project does not see the onboarding
   wizard automatically triggered on first login — detect org state (e.g. project count > 0) before
   deciding to auto-launch the wizard. Edge case: an org with 0 projects but ≥1 existing member
   (e.g. the very first owner completed signup but abandoned the wizard before creating a project)
   should still show the wizard to a newly joining second admin, since the org genuinely has no
   project yet — the gate is "does this org have any projects," not "is this the first user."

### C — Sealed-vault explanation

9. **Sealed state shows plain-language explanation (happy path).** When `readiness.state ===
   'sealed'`, the vault gate (`VaultGate.svelte` via `gate-model.ts`) displays static, in-product
   copy explaining what "sealed" means (e.g. "The vault's encryption key is not currently loaded
   into memory. This happens after a restart or an explicit re-seal. Enter the unseal passphrase
   below to continue.") in addition to whatever `readiness.message` the API returns — do not rely
   solely on API-supplied copy, since that message's content/quality is outside this story's control
   and the audit explicitly flagged the *in-product* explanation as missing.
10. **Uninitialized vs. sealed vs. unavailable have distinct explanations.** `gate-model.ts` already
    branches on `uninitialized`, `sealed`, and `unavailable` states with different `eyebrow`/`title`
    values — extend each branch (not just `sealed`) with a short static explanatory line appropriate
    to that state, so a first-time operator (`uninitialized`) and a post-restart operator (`sealed`)
    get different, state-appropriate context rather than generic vault copy.
11. **Explanation copy is present even if the API's `message` field is empty or missing.** Add a
    test asserting the static explanatory copy renders even when `readiness.message` is `''` or
    `undefined` — the fix must not be purely a concatenation with API-supplied text that silently
    disappears if that text is empty.

### D — Accessibility

12. **Focus indicators visible on primary dark buttons (happy path).** Tab to "Create Project,"
    "Save Credential," "Go to Dashboard," and any other primary CTA styled with the app's dark
    (`bg-slate-950`-class) button treatment; the focus ring is visibly distinguishable against the
    button's background, meeting WCAG 2.1 AA 2.4.7. Verify via computed-style inspection (contrast
    ratio of the focus ring against the button background, not just visual eyeballing), matching the
    audit's own verification method.
13. **Focus-visible fix is applied app-wide via a shared style, not per-button.** Locate the
    Tailwind class/utility currently producing the near-invisible outline on `bg-slate-950` buttons
    and fix it at the shared component/utility level (e.g. a shared button class or a
    `focus-visible:` utility using a contrasting ring color like `focus-visible:ring-2
    focus-visible:ring-brand-400 focus-visible:ring-offset-2`) so every current and future
    `bg-slate-950` button inherits the fix — do not patch individual buttons one at a time, which
    would leave the same bug for any button not explicitly touched.
14. **Destructive actions visually distinguished by more than color (happy path).** On Settings →
    Users, "Deactivate account," "Remove from organization," and "Request erasure" are visually
    distinguished from "Send recovery link" and "Pseudonymize identity" by a signal beyond text
    color alone — e.g. a grouped "danger zone" section with a border/heading, a warning icon
    adjacent to each destructive label, or placement in a separate menu. Verify by checking the
    rendered output does not rely solely on `text-red-700`/`text-amber-700` vs `text-slate-700`
    classes to convey destructiveness.
15. **Every destructive action requires a confirmation naming the user and action.** "Deactivate
    account" already calls `confirm(...)` with the user's email (verified in
    `onDeactivateOrgUser`, `apps/web/src/routes/(app)/settings/users/+page.svelte`) — verify this
    pattern; if "Remove from organization" (`onRemoveOrgUser`) or "Request erasure"
    (`openErasureRequest`) do not already have an equivalent named confirmation step, add one
    matching the existing `confirm(...)` pattern's specificity (user email + action name in the
    message), rather than a generic "Are you sure?" with no specifics. Edge case: confirmation text
    must use the target user's actual email/identifier dynamically, not a static placeholder string
    — verify this by testing with two different users and asserting the confirmation message differs.
16. **Notification-preference row controls have row-scoped accessible names.** Each row's
    `frequency` and `minSeverity` `<select>` elements
    (`apps/web/src/routes/(app)/settings/notifications/+page.svelte` lines ~78-93, ~121-129) get an
    `aria-label` (e.g. `` `Frequency for ${pref.alertType} via ${pref.channel}` ``) or
    `aria-labelledby` pointing at a row-identifying element, mirroring the existing pattern already
    used elsewhere in the codebase for the same problem (see
    `aria-label={`Role for ${user.email} in ${project.projectName}`}` in
    `apps/web/src/routes/(app)/settings/users/+page.svelte` — reuse that exact pattern/convention).
    Verify via a screen-reader-equivalent query (`getByRole('combobox', { name: ... })` in tests)
    that each row's controls are individually addressable, not just visually distinct.
17. **404 page uses the app shell and offers a way back (happy path).** Add
    `apps/web/src/routes/+error.svelte` rendering within (or visually matching) the app's normal
    shell — header/branding/landmarks — with a "Back to Dashboard" link
    (`href={resolve('/dashboard')}`), replacing SvelteKit's default bare error output for any
    unmatched route. Verify via accessibility-tree dump that `banner`/`navigation`/`main` landmarks
    are present, matching the audit's own verification method.
18. **404 page handles both unauthenticated and authenticated visitors.** An unauthenticated visitor
    hitting an unmatched route sees the 404 shell with a link to `/login` (not `/dashboard`, which
    would just bounce them through an auth redirect); an authenticated visitor sees a link to
    `/dashboard`. If distinguishing auth state in `+error.svelte` is impractical (SvelteKit error
    pages have limited access to load data), a link to `/` (which itself redirects appropriately
    based on auth state, if that's the existing root-route behavior — confirm via
    `apps/web/src/routes/(app)/root-page.server.test.ts`) is an acceptable equivalent; document
    whichever approach is taken.
19. **404 page also covers genuine 4xx/5xx errors distinctly.** If `+error.svelte` is reached via a
    thrown 500 (not just an unmatched route), the page does not claim "Page not found" — check
    `page.status`/`page.error` (SvelteKit's error page conventions) and show status-appropriate
    copy (e.g. "Something went wrong" for 5xx vs. "Page not found" for 404), still within the same
    branded shell.
20. **Copy-to-clipboard produces a visible, announced confirmation.** The credential detail page's
    "Copy" button (for a revealed value) shows a brief, auto-dismissing inline confirmation (e.g.
    "Copied to clipboard") exposed via `role="status"`/`aria-live="polite"` — mirroring the existing
    correctly-implemented pattern already used for "✓ Credential saved securely" on the same page
    (confirmed by the audit as correctly using `role="status"` — find and reuse that exact
    component/pattern rather than introducing a new toast mechanism).
21. **Clipboard failure edge case.** If `navigator.clipboard.writeText` rejects (e.g. permissions
    denied, non-secure context), the same `role="status"` region announces a failure message (e.g.
    "Couldn't copy — copy manually") rather than silently doing nothing or throwing an unhandled
    promise rejection.

### E — Naming and content consistency

22. **Event-type strings render through one consistent human-readable mapping (happy path).**
    Settings → Notifications preferences and Settings → Audit & Compliance both render event types
    through a single shared presentation-layer mapping (e.g. a new
    `apps/web/src/lib/format/event-type-labels.ts` or equivalent shared module) producing one
    consistent human label + icon per event type — e.g. an internal `audit_storage.critical` /
    `SESSION_CREATED`-style code always renders as the same human label (e.g. "Backup failure" /
    "Session created") in both places, never the raw code.
23. **Unmapped event type does not crash or render raw garbage.** If an event-type code appears that
    has no entry in the shared mapping (e.g. a new event type added by a future story that forgot to
    update the mapping), the fallback renders a readable humanized fallback (e.g. title-casing the
    raw string, stripping underscores/dots) rather than throwing, rendering `undefined`, or leaking
    the exact raw internal code verbatim with its original casing convention.
24. **Nav label and page heading are consistent.** The nav item currently labeled "Alerts"
    (`nav-model.ts`) and the destination page's `<h1>`/heading
    (`apps/web/src/routes/(app)/notifications/+page.svelte`) use the same term — pick one (verify
    which term is more established elsewhere in the app, e.g. check whether "notifications" or
    "alerts" is the dominant term in the API/data model before choosing) and apply it to the nav
    label, the page's `<h1>`, and any sub-headings (including the "DORMANT USER ALERTS" sub-heading
    flagged in the audit, if it still exists).
25. **Registration copy is conditional on actual org count.** `apps/web/src/routes/(auth)/register/+page.svelte`
    line ~20's `'Create the first organization account for this vault.'` string is replaced with
    copy that is accurate regardless of whether other orgs exist — either (a) conditionally render
    "Create the first..." only when the instance genuinely has zero orgs (requires a data source for
    org count on this page — check what's already loaded/available to `+page.server.ts` for this
    route), or (b) rewrite the copy to not claim scarcity at all (e.g. "Create a new, independent
    organization" — since each registration always creates an isolated org regardless of how many
    already exist, per the audit's own suggested fix). Prefer (b) if org count isn't already cheaply
    available to this route, since it's simpler and avoids a new data dependency on an
    unauthenticated page.
26. **Regression: existing register-page tests still pass** after the copy change, with assertions
    updated to match the new copy exactly (do not leave a stale assertion on the old "first
    organization" string).

## Tasks / Subtasks

- [x] Task 1 — Dashboard staleness fix (AC: 1, 2, 3, 4)
  - [x] Trace `OnboardingWizard.svelte`/`onboarding-logic.ts`'s completion → `/dashboard` transition
  - [x] Fix the actual root cause (invalidation/race/hard-nav — see AC-2)
  - [x] Add a test simulating a slow final mutation (AC-3) and a failing final mutation (AC-4)
- [x] Task 2 — Onboarding modal escape hatch (AC: 5, 6, 7, 8)
  - [x] Add visible close/skip control to `OnboardingDialog.svelte`
  - [x] Add Escape-key handler wired to the same close logic
  - [x] Verify no unintended mutation/rollback on early dismissal
  - [x] Gate auto-launch on org project count, not "first user"
- [x] Task 3 — Sealed-vault explanation (AC: 9, 10, 11)
  - [x] Extend `gate-model.ts`'s three state branches with static explanatory copy
  - [x] Add tests for empty/missing API `message`
- [x] Task 4 — Accessibility fixes (AC: 12-21)
  - [x] Fix focus-visible ring at the shared dark-button style level
  - [x] Add danger-zone visual grouping + confirmation parity on Settings → Users
  - [x] Add row-scoped `aria-label`s to Notification-preferences `<select>`s
  - [x] Add `apps/web/src/routes/+error.svelte` with app shell + status-aware copy
  - [x] Add `role="status"` clipboard-copy confirmation (success + failure)
- [x] Task 5 — Naming/content consistency (AC: 22-26)
  - [x] Add shared event-type label mapping module; wire into Notifications settings + Audit log
  - [x] Reconcile "Alerts" nav label vs. "Notifications" page heading
  - [x] Fix register-page copy; update its test assertions

## Out of scope for this story

- **Notification Preferences table redesign** (grouping under collapsible category headers, bulk
  toggles, single "Save all," filter) — larger redesign than this story's row-labeling fix (AC-16);
  split into its own follow-up story at dev-story time. Applies to this story's area (D), not to
  `12-1-project-information-architecture`.
- **"Reveal value" auto-hide/timeout** (15-30s countdown, re-hide on route change/window blur),
  **cron-field help/presets** for rotation schedules, **login-page tagline styling** — lower-severity
  polish items from the audit; bundle into a follow-up polish story rather than either split story.
  Not related to either split's core scope.
- **Persistent MFA banner not being an actual link/button** (audit UX finding #2) — this is a
  correctness/accessibility gap (a `generic` element that should be a `link`) that overlaps this
  story's accessibility theme, but was not included in the original bundled story's numbered AC list
  and was likely an oversight in the original story's scoping — flagging here rather than silently
  adding it, since it wasn't in either split's inherited AC set; recommend a small follow-up story or
  folding it into whichever of the two splits' dev-story pass has capacity, at the team's discretion.
- **Dormancy-threshold caveat visibility** (Settings → Users, audit UX finding #15) and **cron-field
  contrast** (audit accessibility finding on placeholder contrast) — low-severity items not in the
  original bundled story's numbered ACs either; same treatment as above.
- **Platform-operator-only screens** (system settings, backup admin, platform audit log, upgrade
  page) were not reachable in the audit's org-owner login and were not reviewed — needs a separate
  pass with platform-operator access before any findings can be claimed there. Applies to neither
  split story.
- **Project information architecture** (project overview page, credentials-as-sibling-route,
  persistent project sub-nav, dashboard/list card linking) — entirely out of scope for this story;
  see `12-1-project-information-architecture`.

## Dev Notes

### No migration/rollout concerns

Unlike the sibling `12-1-project-information-architecture` story, this story touches existing pages
in place (bug fixes, copy changes, accessibility attributes, one new `+error.svelte`) rather than
introducing new routes or a new shared-nav component consumed by many pages — no flag, redirect, or
sequencing concerns apply. Each AC group (B/C/D/E) is independently shippable and low-risk; they can
land in one PR or be split across several without any ordering dependency between groups.

### Architecture / pattern compliance

- Reuse existing patterns wherever the Background section identifies one (e.g. the `aria-label`
  pattern already used in `settings/users/+page.svelte`, the `role="status"` pattern already used
  for credential-save confirmation, the `confirm(...)` pattern already used for deactivate) — this
  story is explicitly about closing gaps where an established good pattern exists in one place but
  wasn't applied consistently elsewhere.
- `+error.svelte` (AC-17-19) is a SvelteKit-specific mechanism; confirm current SvelteKit version's
  exact `page.status`/`page.error` shape in `apps/web/package.json` before implementing, since the
  precise access pattern has changed across SvelteKit major versions.

### Project Structure Notes

- New file: `apps/web/src/routes/+error.svelte`.
- New file (likely): `apps/web/src/lib/format/event-type-labels.ts` (or wherever this repo's existing
  formatting/presentation helpers live — check `apps/web/src/lib/format/` or `apps/web/src/lib/utils/`
  for an existing convention before creating a new directory).
- Modified files: `apps/web/src/lib/components/onboarding/OnboardingDialog.svelte`,
  `apps/web/src/lib/components/onboarding/OnboardingWizard.svelte` and/or `onboarding-logic.ts`,
  `apps/web/src/lib/components/vault/gate-model.ts`, `apps/web/src/routes/(app)/settings/users/+page.svelte`,
  `apps/web/src/routes/(app)/settings/notifications/+page.svelte`,
  `apps/web/src/lib/components/shell/nav-model.ts` and/or
  `apps/web/src/routes/(app)/notifications/+page.svelte`,
  `apps/web/src/routes/(auth)/register/+page.svelte`, and the credential detail page's copy-to-
  clipboard handler (locate via the existing "Credential saved securely" `role="status"` component).
- No `apps/api/**` changes expected — every AC in this story is presentation-layer (copy, ARIA
  attributes, client-side navigation timing, static explanatory text). If the dashboard-staleness
  root cause (AC-1/AC-2) turns out to require an API-side change (e.g. the API itself has a
  read-after-write consistency gap, not just a client caching bug), that is a scope-affecting
  discovery — flag it rather than silently expanding this story's surface into `api`.

### References

- [Source: docs/usability-audit-2026-07-13.md#3-ux-expert-findings] (findings #1, #3, #4, #6, #7, #9)
- [Source: docs/usability-audit-2026-07-13.md#4-accessibility-findings-wcag-21-aa]
- [Source: docs/usability-audit-2026-07-13.md#1-product-owner-findings-nestor] (P4)
- [Source: apps/web/src/lib/components/onboarding/OnboardingDialog.svelte]
- [Source: apps/web/src/lib/components/vault/gate-model.ts]
- [Source: apps/web/src/routes/(app)/settings/users/+page.svelte] (lines ~420-495)
- [Source: apps/web/src/routes/(app)/settings/notifications/+page.svelte] (lines ~78-93, ~121-129)
- [Source: apps/web/src/routes/(auth)/register/+page.svelte] (line ~20)
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]
- Sibling split (independent, not a dependency): `_bmad-output/implementation-artifacts/12-1-project-information-architecture.md`

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5

### Debug Log References

### Completion Notes List

- Story created by splitting the original bundled `12-1-usability-and-navigation-fixes` story into
  this trust/accessibility/consistency story and the sibling `12-1-project-information-architecture`.
  Grounded in direct source inspection (2026-07-13) of `OnboardingDialog.svelte`, `gate-model.ts`,
  `settings/users/+page.svelte`, `settings/notifications/+page.svelte`, and `register/+page.svelte`
  rather than assumption; identified that "MFA banner not a link," "dormancy caveat visibility," and
  "cron placeholder contrast" were present in the audit doc but never made it into the original
  bundled story's numbered ACs — documented under Out of scope rather than silently added or dropped.

- **Implementation (2026-07-23), TDD red-green throughout, all 26 ACs implemented:**
  - **AC-1–4 (dashboard staleness):** Root-caused via direct trace, not assumption — the wizard
    never `goto()`s at all; `(app)/+layout.svelte` renders `OnboardingWizard` in place of
    `children()` behind an `{#if !onboardingDone}`, so the dashboard route's `+page.server.ts`
    `load` had already fired (in parallel with the layout's own load, as part of the initial
    navigation) *before* the wizard's mutations landed, and was never re-run once `onboardingDone`
    flipped client-side. Fixed by awaiting `invalidateAll()` in the layout's `oncompleted` handler
    before flipping `onboardingDone`, so `children()` never mounts with stale data — no polling
    loop, no artificial delay. AC-3/AC-4 were largely already covered by each wizard step awaiting
    its own mutation before advancing/calling `oncompleted`; added regression tests proving the
    slow/failing cases explicitly.
  - **AC-5–8 (onboarding escape hatch):** Added a visible "×" close button (`aria-label="Close"`)
    and an `Escape` keydown handler to `OnboardingDialog.svelte`, both wired to the wizard's
    existing `dismissWizard()` (previously only reachable via the viewer no-permission paths) —
    reuses the established fail-open `completeOnboarding` + `oncompleted()` pattern rather than
    inventing new dismissal semantics. AC-8: `(app)/+layout.server.ts` now treats onboarding as
    completed whenever the org already has ≥1 project, regardless of this specific user's own
    per-user onboarding flag (previously gated purely on "has *this user* completed onboarding",
    which is the literal root cause of the wizard force-firing for a second admin joining an
    already-set-up org).
  - **AC-9–11 (sealed-vault explanation):** `gate-model.ts`'s `VaultGateModel` gained a new
    `explanation` field, populated with distinct static copy for all three gated states
    (`uninitialized`/`sealed`/`unavailable`), rendered by `VaultGate.svelte` independently of
    (and unconditionally alongside) whatever `readiness.message` the API returns — verified via a
    test asserting the explanation still renders when `message` is `''`.
  - **AC-12–13 (focus-visible contrast):** Fixed once at a shared `.bg-slate-950:focus-visible`
    CSS rule in `app.css` (keyed off the existing utility class already used by ~35 buttons app-
    wide, so no per-button changes were needed) using a new `--color-brand-400` theme token as the
    ring color. Verified by computation (not eyeballing): a new `color-contrast.ts` WCAG
    luminance/contrast-ratio utility asserts the ring color meets the 3:1 AA 2.4.7 minimum against
    `slate-950`.
  - **AC-14–15 (destructive-action grouping + confirmation parity):** Settings → Users now groups
    Deactivate/Remove/Request-erasure in a bordered, labeled "Danger zone" with a warning icon on
    each button (verified via `data-testid="danger-zone"` + icon-count assertions, not just
    color-class checks). `onSubmitErasureRequest` gained the same named `confirm(...)` pattern
    already used by deactivate/remove, tested with two different users to prove the message isn't
    a static placeholder.
  - **AC-16 (notification row aria-labels):** Reused the exact
    `` `Role for ${user.email} in ${project.projectName}` `` convention already established in
    `settings/users/+page.svelte`; both `frequency`/`minSeverity` `<select>`s now carry
    row-scoped `aria-label`s.
  - **AC-17–19 (404/error page):** New `apps/web/src/routes/+error.svelte` — a minimal branded
    shell (not the full `AppShell`, which requires an authenticated `user` prop the error page
    can't always supply) using semantic `<header>`/`<nav>`/`<main>` for landmark coverage,
    status-aware copy (`page.status`/`page.error`), and a single back-link that reads
    `page.data.user` when available (e.g. a genuine 500 thrown after `(app)/+layout.server.ts`
    already ran) and falls back to `/` — confirmed via `root-page.server.test.ts` that `/` already
    redirects correctly by auth state — documented here per AC-18 as the taken approach.
  - **AC-20–21 (clipboard confirmation):** Reused the same `role="status"` pattern already used
    for "✓ Credential saved securely" on the same page; added an auto-dismissing (3s) success/
    failure status message to `copyValue()`.
  - **AC-22–23 (event-type label mapping):** New `apps/web/src/lib/utils/event-type-labels.ts`
    (colocated with the existing `format-bytes.ts` utility convention, not a new `format/`
    directory). `getEventTypeLabel()` combines a curated override map with labels auto-derived
    from every canonical `AuditEvent` constant in `@project-vault/shared` (a completeness guard
    test iterates all of them), falling back to a humanized title-case transform
    (`humanizeEventType`) for any code with no entry — addresses the adversarial review's
    completeness-gap finding beyond the AC's literal minimum. Wired into both
    `settings/notifications/+page.svelte` and `settings/audit/+page.svelte`, replacing two
    separate inline `ALERT_TYPE_LABELS` maps.
  - **AC-24 (nav/heading consistency):** Renamed the nav item from "Alerts" to "Notifications" in
    `nav-model.ts` — "Notifications" is the dominant term (page `<h1>`, page title, route name,
    settings page name), so the nav label moved to match rather than the reverse.
  - **AC-25–26 (register copy):** Replaced the scarcity-implying "Create the first organization
    account for this vault" with "Create a new, independent organization in this vault" (option
    (b) from the AC, since org count isn't already loaded on this unauthenticated route); updated
    the existing register-page test assertion to match.
  - Full targeted test suite (`apps/web`): 1535/1535 passing, plus `eslint .` (0 errors, pre-existing
    warnings only) and `svelte-kit sync && tsc --noEmit` (clean) both green.

### File List

**New:**
- `apps/web/src/routes/+error.svelte`
- `apps/web/src/routes/error-page.test.ts`
- `apps/web/src/lib/utils/event-type-labels.ts`
- `apps/web/src/lib/utils/event-type-labels.test.ts`
- `apps/web/src/lib/utils/color-contrast.ts`
- `apps/web/src/lib/utils/color-contrast.test.ts`
- `apps/web/src/app.css.test.ts`
- `apps/web/src/lib/components/shell/nav-model.test.ts`

**Modified:**
- `apps/web/src/routes/(app)/+layout.svelte`
- `apps/web/src/routes/(app)/+layout.server.ts`
- `apps/web/src/routes/(app)/app-layout.test.ts`
- `apps/web/src/routes/(app)/app-layout.server.test.ts`
- `apps/web/src/lib/components/onboarding/OnboardingDialog.svelte`
- `apps/web/src/lib/components/onboarding/OnboardingWizard.svelte`
- `apps/web/src/lib/components/onboarding/OnboardingWizard.test.ts`
- `apps/web/src/lib/components/vault/gate-model.ts`
- `apps/web/src/lib/components/vault/VaultGate.svelte`
- `apps/web/src/lib/components/vault/VaultGate.test.ts`
- `apps/web/src/routes/vault.test.ts`
- `apps/web/src/app.css`
- `apps/web/src/routes/(app)/settings/users/+page.svelte`
- `apps/web/src/routes/(app)/settings/users/users-page.test.ts`
- `apps/web/src/routes/(app)/settings/notifications/+page.svelte`
- `apps/web/src/routes/(app)/settings/notifications/notifications-settings-page.test.ts`
- `apps/web/src/routes/(app)/settings/audit/+page.svelte`
- `apps/web/src/routes/(app)/settings/audit/audit-page.test.ts`
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte`
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/credential-detail-page.test.ts`
- `apps/web/src/lib/components/shell/nav-model.ts`
- `apps/web/src/lib/components/shell/AppShell.test.ts`
- `apps/web/src/routes/mobile-smoke.test.ts`
- `apps/web/src/routes/(auth)/register/+page.svelte`
- `apps/web/src/routes/(auth)/register/page.test.ts`

## Change Log

| Date | Change |
|------|--------|
| 2026-07-23 | Story implemented end-to-end (all 26 ACs, TDD red-green): dashboard-staleness fix via `invalidateAll`, onboarding escape hatch + org-based wizard gate, sealed-vault static explanations, shared focus-visible fix, danger-zone grouping + erasure confirmation, notification row aria-labels, branded 404/error page, clipboard copy confirmation, shared event-type label mapping, nav/heading rename, register copy fix. Status: ready-for-dev → review. |
