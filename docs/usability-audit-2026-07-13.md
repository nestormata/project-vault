# Usability Audit — 2026-07-13

A full-app usability review conducted against a live local Docker stack (`make bootstrap-docker`,
seeded via `db:seed:demo`), navigated end-to-end in a real browser and cross-checked by two
independent expert reviews (UX and accessibility). This document is the source for epic 12's
backlog stories — see `_bmad-output/implementation-artifacts/12-1-usability-and-navigation-fixes.md`.

**Scope walked:** login/register, the first-run onboarding wizard, dashboard, projects list and
project detail, credentials list/detail/rotation, Alerts/Notifications inbox, cross-project Health,
the Settings hub (Notifications preferences, Users, Security/MFA, Audit & Compliance), project
Members and Machine Users, and the app's 404 fallback. Platform-operator-only screens (system
settings, backup admin, platform audit log, upgrade page) were not reachable from this org-owner
login and are out of scope for this pass.

**Methodology:** one pass driven directly in Chrome by the lead agent (raw notes below informed
everything else), plus two independent expert subagents given browser access to the same running
instance: a UX-lens review (interaction design, IA, copy, trust) and an accessibility-lens review
(WCAG 2.1 AA, verified via DOM/computed-style inspection and accessibility-tree dumps, not just
visual inspection). A third pass asked the UX reviewer for a concrete information-architecture
recommendation after the product owner flagged a structural navigation problem.

---

## 1. Product owner findings (Nestor)

- **P1 — Dashboard/list items aren't clickable through.** Project cards (and other listed elements)
  don't let you click the name to open that item's page; you must find a separate button/link.
- **P2 — The "Credentials" page has silently become the project hub.** Every project sub-area —
  Members, Machine Users, Public status page, Services, Certificates, Domains, Endpoints — has its
  entry point on the Credentials page, not on a dedicated project overview page. There is no "project
  page" distinct from the credentials list, which reads as if credentials *is* the project.
- **P3 — No way back from project sub-pages.** Navigating from Credentials into Members, Machine
  Users, Public status page, Services, Certificates, Domains, or Endpoints leaves no link back to
  the project/credentials page — only browser back.
- **P4 — The "sealed" vault state isn't explained.** When the vault is sealed, the UI should explain
  *why* it's sealed and what "sealed" actually means (envelope encryption locked, master key not in
  memory, etc.) rather than just presenting an unseal action with no context — an operator who hits
  this state cold (e.g. after a restart) has no in-product explanation of what happened or why they
  need to re-enter a passphrase.

## 2. Recommended information architecture (UX expert, addressing P1–P3)

**Verdict on P2: rename/restructure.** This is "hub drift" — Credentials was the first project-scoped
page built, so every later feature bolted its nav entry onto it instead of a proper project home. It's
the same *shape* of problem as finding UX-7 below (Alerts vs. Notifications naming mismatch): URL,
page title, and the user's mental model have drifted apart. Here it's worse because it's structural —
an entire IA layer (the project overview) is missing, and Credentials is impersonating it.

**Concrete recommendation:**

1. **Introduce a real project home at `/projects/:id`.** Project name, description/tags, ownership,
   and an at-a-glance summary (member count, services/certs expiring soon, endpoint/status-page
   health) — this becomes the actual "project page."
2. **Demote Credentials to a sibling route** (`/projects/:id/credentials`, URL can stay the same) —
   one tab among equals, not the landing page. Members/Machine Users/Services/Certificates/Domains/
   Endpoints/Status Page each get their own route at the same level (several likely already exist
   as standalone routes only reachable via the Credentials page's links today — this is mostly
   re-parenting navigation, not rebuilding pages).
3. **Persistent sub-nav across every project screen** — a tab bar (or sub-sidebar if the section
   list grows) fixed under the project header, identical on Overview and all sub-pages:
   `Overview | Credentials | Members | Machine Users | Services | Certificates | Domains | Endpoints
   | Status Page`. This directly solves P3: you're never off the project's frame, so "back to
   project" is just clicking Overview (or the project name in the header). A breadcrumb can be added
   too but should be redundant with, not a substitute for, these persistent tabs.
4. **P1 fix**: make the project card's name (or the whole card) an anchor to `/projects/:id` (the new
   Overview page, not Credentials). Keep an explicit "Manage"/"View credentials" button alongside if
   a direct-to-credentials shortcut is still useful for power users.

**Sequencing**: the tab bar (step 3) is the load-bearing piece and can ship against the existing
sub-pages before the Overview page's dashboard content is fully built out — start Overview as a thin
page (project metadata + tab bar) and iterate. The route rename (step 2) is low-risk since it doesn't
touch the credentials table itself. The card-link fix (step 4) is a one-line change and should ship
regardless of sequencing.

## 3. UX expert findings

### High
1. **Dashboard shows a false "empty" state immediately after onboarding** (`/dashboard`, right after
   the 3-step wizard). Total credentials/projects render as 0 seconds after the user created both —
   for a tool whose whole pitch is "never lose track of your secrets," the first authenticated screen
   after setup looks like it already lost the secret. A reload fixes it (stale client cache/missing
   invalidation), but the user has no way to know that in the moment. **Fix:** invalidate/refetch the
   dashboard query when the wizard's final step fires, or hard-navigate instead of a client route
   change.
2. **Persistent MFA banner is nagging but non-actionable.** Shown on every page: "MFA enrollment is
   required for Owner and Admin roles. Enroll at /settings/security." Plain text, not a link, no
   dismiss control. Trains users to ignore security banners. **Fix:** make it an actual link/button
   ("Set up MFA now"), add a dismiss/snooze or de-escalating treatment after first acknowledgment.
3. **Destructive account actions are visually indistinguishable from safe ones** (Settings → Users).
   "Deactivate account," "Remove from organization," "Request erasure" share styling with "Send
   recovery link" and sit directly adjacent, no grouping/icon/divider, no confirmation observed before
   they'd fire. **Fix:** move destructive actions to a distinct danger zone or overflow menu, use a
   destructive-button style, require a confirmation naming the specific user + action.
4. **Forced onboarding modal has no escape hatch.** No close/skip button, nothing visible behind it.
   Risky combined with finding #1 — if the wizard's mutations appear to fail on the dashboard, there's
   no way to back out and verify independently. Also fires even for a second admin joining an
   already-set-up org. **Fix:** add a visible "Skip for now," and detect org state so it doesn't
   force-fire when the org already has projects.

### Medium
5. **Notification Preferences is an unscannable 30+ row flat table** (Settings → Notifications) — one
   row per alert-type × channel, no grouping, no filter, per-row "Save" links. **Fix:** group under
   collapsible category headers, add bulk toggles and a single "Save all," add a filter.
6. **Inconsistent event-type naming leaks into user-facing tables** (Notifications settings, Audit &
   Compliance) — dotted snake_case (`audit_storage.critical`), Title Case ("Backup Failure"), and
   SCREAMING_SNAKE_CASE (`SESSION_CREATED`) all appear in the same column. **Fix:** one presentation-
   layer mapping from internal event-type strings to a single consistent human label + icon; never
   render raw internal codes to end users.
7. **Nav label doesn't match page heading**: "Alerts" in the nav leads to a page titled
   "Notifications" with a "DORMANT USER ALERTS" sub-heading. **Fix:** pick one term, use it
   consistently across nav label, `<h1>`, and sub-headings.
8. **Bare, unbranded 404 page** for any unmatched route — no header/nav/branding/way back. **Fix:**
   give it the app shell plus a "Back to Dashboard" button.
9. **Silent clipboard copy** on the credential detail page's "Copy" button — no toast/confirmation.
   **Fix:** brief inline "Copied to clipboard" confirmation, auto-dismissing.
10. **"Reveal value" has no auto-hide/timeout** — stays visible indefinitely (screen-share/unattended-
    machine risk for a secrets manager). **Fix:** auto-hide timer (15–30s) with visible countdown,
    re-hide on route change/window blur.
11. **Onboarding's "field went blank" moment has no explanation** — the Value field clears right after
    "Credential saved securely" appears; correct security practice, but reads like a bug with no
    micro-copy tying the two together. **Fix:** one line of copy: "Value cleared from the screen for
    your security — it's saved."

### Low
12. **Cron field offers no help for non-experts** (credential Lifecycle → Rotation schedule) — only a
    greyed placeholder, no tooltip/presets/docs link. **Fix:** add preset buttons ("Monthly," "Weekly,"
    "Every 90 days") and a syntax link.
13. **Registration copy implies scarcity that isn't true** — "Create the first organization account
    for this vault" when other orgs already exist. **Fix:** if registration always creates a new,
    isolated org, say that plainly instead of "the first."
14. **Login page's top box reads as a broken placeholder** — unstyled gray box: "Sign in to continue."
    **Fix:** either style as a proper subtitle/tagline or remove the box chrome.
15. **Dormancy-threshold caveat is easy to miss** (Settings → Users) — important "not retroactive"
    disclosure is just body text above a dropdown. **Fix:** move into an inline tooltip/callout beside
    the control itself.

## 4. Accessibility findings (WCAG 2.1 AA)

### High
- **Onboarding modal has no close control and Escape doesn't dismiss it** — verified `role="dialog"
  aria-modal="true"` with no close button in the DOM; Escape leaves it open. No keyboard-only escape
  mechanism exists. *(2.1.2 No Keyboard Trap — in spirit; 2.4.3/3.2.1 operability)*
- **Focus indicator on primary dark buttons is effectively invisible** — computed styles show a near-
  black 1px outline on a near-black (slate-950) button background, reused across "Create Project,"
  "Save Credential," "Go to Dashboard," and likely other primary CTAs app-wide. *(2.4.7 Focus Visible)*
- **Bare 404 page has zero landmarks and no recovery path** — confirmed via accessibility-tree dump:
  no banner, no navigation, no main landmark, no link back. *(2.4.1 Bypass Blocks / navigability)*

### Medium
- **Destructive/irreversible user actions inconsistently distinguished** (Settings → Users) — verified
  5 real `<button>` elements per row; "Request erasure" (GDPR-permanent) shares identical default
  styling with "Send recovery link" and "Pseudonymize identity." No confirmation step observed.
  *(1.4.1 Use of Color)*
- **Notification-preferences row controls lack accessible names tied to their row** — real `<table>`
  with proper `<th>` headers, but each row's `<select>` has no `aria-label`/`aria-labelledby`
  (confirmed via JS query, all null); screen-reader users hear dozens of identically-named "combobox,
  Immediate" controls with no row context. *(4.1.2 Name, Role, Value; 1.3.1 Info and Relationships)*
- **Copy-to-clipboard gives no confirmation to anyone** — no visible toast, no `aria-live`/
  `role="status"` region appears after the click. *(4.1.3 Status Messages)*
- **Dashboard regions are unlabeled landmarks** — multiple `region` elements rely on adjacent plain
  text rather than `aria-labelledby`; screen-reader users lose the eyebrow-label grouping context
  sighted users get. *(1.3.1 Info and Relationships)*
- **Post-onboarding dashboard falsely reports empty state with no transitional status** — same bug as
  UX finding #1, but flagged here for its accessibility angle: no loading indicator or `aria-live`
  region distinguishes "still fetching" from "confirmed empty," so it reads as data loss rather than
  a stale-cache glitch. *(4.1.3 Status Messages)*
- **Persistent MFA banner names a path but isn't a link** — confirmed via accessibility tree: `generic`,
  not `link`. Keyboard users cannot activate it at all.
- **Rotation-schedule (cron) placeholder text fails contrast and disappears on interaction** — computed
  placeholder color ~`rgb(128,130,139)` on white ≈ 3.8:1, below the 4.5:1 AA threshold, and it's the
  *only* format guidance offered; vanishes entirely once the field is focused. *(1.4.3 Contrast Minimum)*

### Low
- **Nav label / page heading mismatch: "Alerts" vs "Notifications"** — same issue as UX finding #7,
  also flagged for consistent-identification purposes. *(2.4.6 Headings and Labels)*
- **Register page copy is misleading in a multi-tenant instance** — same as UX finding #13; a
  comprehension issue, not a strict SC failure.
- **Success-message content doesn't disambiguate a security-driven UI change** — the "✓ Credential
  saved securely" status message is correctly exposed to assistive tech (`role="status"`, verified),
  but its content doesn't explain why the Value field cleared.

### Notable positive
The onboarding dialog correctly moves programmatic focus to each step's heading on transition and
carries proper `role="dialog"`, `aria-modal="true"`, `aria-labelledby` — the modal semantics and
focus-on-open behavior are implemented correctly. The only missing piece is the lack of any dismissal
mechanism.

## 5. Cross-cutting themes

- **Naming-taxonomy inconsistency** shows up in three unrelated places (event types in Notifications
  settings and Audit log; Alerts-vs-Notifications nav/heading mismatch; Credentials-vs-Project IA
  drift) — worth treating as one systemic issue, not three unrelated papercuts.
- **Status/confirmation feedback is inconsistent**: some actions get a correctly-implemented
  `role="status"` message (credential save), others get nothing at all (clipboard copy), and one gets
  actively wrong information (post-onboarding dashboard).
- **Irreversible actions are under-signaled** everywhere they appear (Users page destructive links,
  no confirmation dialogs observed) — this matters more than usual for a secrets/access-control
  product.
