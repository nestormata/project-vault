# Story 12.1: Usability and Navigation Fixes

Status: backlog

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

<!-- Ad-hoc, audit-driven story with no epics.md backlog entry — same precedent as 6-5, 1-14,
     1-15: a new epic (epic-12) registered directly from a findings doc rather than a PRD epic.
     Source: docs/usability-audit-2026-07-13.md, a full-app usability review (own navigation +
     independent UX-expert and accessibility-expert subagent passes, plus product-owner review)
     conducted against a live local Docker stack. This story bundles all findings from that audit
     into one backlog story; given the number and variety of findings (IA restructuring, trust/
     reliability bugs, accessibility, content/naming consistency), expect this to be split into
     several smaller stories via bmad-create-story/plan-story before a dev pass actually starts —
     it is intentionally *not* pre-split here since the product owner asked for "a story" to track
     the findings, not a full epic breakdown. -->

## Story

As an org owner, admin, or member using Project Vault day to day,
I want the app's navigation, first-run experience, and accessibility to be trustworthy and coherent,
so that a security/operations product I depend on doesn't itself create confusion, distrust, or
exclusion for the people using it.

## Background

Full findings, rationale, and severity ranking live in `docs/usability-audit-2026-07-13.md`. Summary
of the themes that produced this story's AC groups:

- **Project information architecture is drifted.** The "Credentials" page has become the de facto
  project hub — every project sub-area (Members, Machine Users, Public status page, Services,
  Certificates, Domains, Endpoints) is only reachable from it, there's no dedicated project overview
  page, no persistent sub-nav, and no way back from a sub-page except browser back. Dashboard/project
  list cards aren't clickable through to a project page either. (Product owner findings P1–P3; UX
  addendum with concrete IA recommendation.)
- **First-run trust is broken.** Right after finishing the onboarding wizard, the dashboard falsely
  shows "no projects/0 credentials" for data that was just created — the worst possible moment for a
  tool whose whole value proposition is "don't lose track of things." The onboarding modal itself has
  no skip/close control, not even via Escape.
- **Sealed vault state is unexplained** (product owner finding P4) — no in-product explanation of
  what "sealed" means or why it happened when an operator hits it.
- **Accessibility gaps**, independently verified via DOM/computed-style inspection and accessibility-
  tree dumps: invisible focus indicators on primary buttons, no keyboard escape from the onboarding
  modal, destructive account actions with no non-color distinguishing signal, unlabeled per-row form
  controls in the notification-preferences table, and a bare unstyled 404 page with zero landmarks.
- **Naming/content inconsistency**: event-type strings shown to users mix three different casing
  conventions across Notifications settings and the Audit log; the "Alerts" nav item leads to a page
  titled "Notifications"; register-page copy implies this is the first org when others already exist.

## Acceptance Criteria

### A — Project information architecture
1. A real project overview page exists at `/projects/:id` showing project metadata (name,
   description/tags, ownership) and an at-a-glance summary (member count; services/certs expiring
   soon; endpoint/status-page health).
2. Credentials moves to a sibling route under the same project (`/projects/:id/credentials`,
   URL may stay as-is) and is presented as one section among equals, not the project's landing page.
3. A persistent sub-nav (tab bar or sub-sidebar) appears identically across the project overview and
   every sub-page — Overview, Credentials, Members, Machine Users, Services, Certificates, Domains,
   Endpoints, Public status page — so every sub-page has a way back to the project overview without
   relying on browser back.
4. On the dashboard and the projects list, a project's name (or its whole card) links directly to its
   `/projects/:id` overview page.

### B — First-run trust and reliability
5. The dashboard reflects freshly-created projects/credentials immediately after the onboarding
   wizard's final step — no stale "0 credentials" / "no projects saved yet" state is shown for data
   that was just created in the same session.
6. The onboarding modal chain has a visible skip/close control, and it does not force-fire for a user
   joining an org that already has projects.
7. Pressing Escape while the onboarding modal (or any app modal) has focus closes it, consistent with
   standard modal keyboard behavior.

### C — Sealed-vault explanation
8. When the vault is sealed, the UI explains what "sealed" means (envelope encryption locked / master
   key not currently held in memory) and why the operator is seeing this state, alongside the unseal
   action — not just a bare unseal form with no context.

### D — Accessibility
9. Focus indicators on primary buttons (including dark/slate-950-styled CTAs like "Create Project,"
   "Save Credential," "Go to Dashboard") are visibly distinguishable against their background,
   meeting WCAG 2.1 AA 2.4.7 (Focus Visible).
10. Destructive/irreversible account actions on Settings → Users (Deactivate account, Remove from
    organization, Request erasure) are visually distinguished from non-destructive actions by more
    than color alone (icon, grouping, or a separate danger-zone placement), and require a
    confirmation step naming the specific user and action before executing.
11. Each row's frequency/severity `<select>` controls on Settings → Notifications have an accessible
    name tied to their row's alert type and channel (e.g. via `aria-label`/`aria-labelledby`), so a
    screen-reader user can distinguish one row's controls from another's without sighted
    cross-reference.
12. The 404 fallback page uses the app shell (header/nav/landmarks) and includes a way back into the
    app (e.g. a "Back to Dashboard" link), rather than rendering as bare unstyled text with no
    landmarks.
13. Copying a revealed credential value to the clipboard produces a visible and screen-reader-
    announced confirmation (e.g. an `aria-live`/`role="status"` toast), not a silent action.

### E — Naming and content consistency
14. Event-type strings shown to end users (Settings → Notifications preferences, Settings → Audit &
    Compliance) are presented through one consistent human-readable label + icon per event type;
    raw internal event codes (in any casing convention) are no longer rendered directly to users.
15. The nav item currently labeled "Alerts" and its destination page's heading/title are made
    consistent with each other (pick one term and use it for the nav label, `<h1>`, and any
    sub-headings).
16. The registration page's copy no longer unconditionally claims to create "the first organization
    account for this vault" when other organizations already exist on the instance.

## Out of scope for this story (tracked in the audit doc, not blocking)

- Notification Preferences table redesign (grouping, bulk actions, filter) — larger redesign, split
  into its own story at dev-story time.
- "Reveal value" auto-hide/timeout, cron-field help/presets, copy micro-copy for the onboarding
  Value-field-clears moment, login-page tagline styling — lower-severity polish items from the audit,
  bundle into a follow-up polish story rather than this one.
- Platform-operator-only screens (system settings, backup admin, platform audit log, upgrade page)
  were not reachable in the audit's org-owner login and were not reviewed — needs a separate pass
  with platform-operator access before any findings can be claimed there.

## Dev Notes

This story is intentionally broad (it mirrors the audit doc's structure) and is expected to be split
into smaller, independently shippable stories before implementation begins — group A (IA
restructuring) is a genuinely separate, larger effort from groups B–E (bug fixes and accessibility
patches) and likely warrants its own story and its own migration/rollout consideration (new route,
new persistent nav component shared across ~8 existing pages).

Reference `docs/usability-audit-2026-07-13.md` for full rationale, severity ranking, and the UX
expert's detailed information-architecture recommendation (section 2) before starting design work on
group A.
