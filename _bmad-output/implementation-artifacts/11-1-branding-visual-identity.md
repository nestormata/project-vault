# Story 11.1: branding-visual-identity

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user of Project Vault,
I want to see the product's logo/icon and a cohesive brand accent color in the app shell and auth pages,
so that the app feels like a polished, trustworthy product rather than an unstyled prototype.

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

Alex-viewer opens Project Vault in a browser. The browser tab shows the Project Vault
icon (favicon) instead of a generic globe/blank icon. Alex lands on `/login` and sees
the Project Vault logo above the sign-in form instead of bare text. After signing in,
the same logo appears in the app header next to (or in place of) the "Project Vault"
text, and primary links/buttons in the header and nav use a consistent violet/purple
accent color instead of the previous near-black CTA styling. No layout shift, no
broken images, no console 404s for the favicon or logo assets.

## Acceptance Criteria

1. **Favicon wired up and resolves 200.** `apps/web/src/app.html`'s existing
   `<link rel="icon" href="%sveltekit.assets%/favicon.png" />` continues to resolve
   (asset already exists at `apps/web/static/favicon.png`, 32×32, 1.6 KB) — verify via
   a network request to `/favicon.png` returning HTTP 200 in a running dev/preview build.
2. **Apple touch icon linked.** Add
   `<link rel="apple-touch-icon" href="%sveltekit.assets%/apple-touch-icon.png" />` to
   `apps/web/src/app.html` `<head>`, pointing at the existing
   `apps/web/static/apple-touch-icon.png` (180×180, 20.5 KB).
3. **Logo renders in the app header.** `apps/web/src/lib/components/shell/AppShell.svelte`
   renders `apps/web/static/logo.png` (238×240) in the header, **placed next to** (not
   replacing) the "Project Vault" text (lines 39-43), at a fixed/constrained height
   (e.g. `h-8` or `h-10` with `w-auto`) so it does not cause layout shift on load.
   The `<img>` **must use `alt=""` (decorative)** — the adjacent "Project Vault" text
   already conveys the name, and `AppShell.test.ts` asserts exact accessible names
   (`getByRole('link', { name: 'Project Vault' })` and `getByText('Project Vault')`);
   a non-empty `alt` on an image placed inside the `<a>`/`<p>` would concatenate into
   the accessible name / text content and break those exact-match assertions. If the
   image is placed as a sibling of the `<a>`/`<p>` rather than nested inside it, this
   is moot, but `alt=""` is required either way to avoid duplicate screen-reader
   announcement of "Project Vault". Preserve the existing `hidePrimaryNav` conditional
   (non-link `<p>` vs. link `<a>` to `/dashboard`) and the "Run complex projects. Miss
   nothing." tagline underneath.
4. **Logo renders in the auth shell.** `apps/web/src/routes/(auth)/+layout.svelte`
   renders the same `logo.png` **alongside** (not replacing) the existing "Project
   Vault" label (line 8) at a similarly constrained size, above the shared card that
   wraps login/register/recovery/invitation-accept pages. Same `alt=""` rule as AC-3
   applies (decorative, adjacent visible text already labels it).
5. **Brand Tailwind theme tokens exist.** `apps/web/src/app.css` defines a `@theme`
   block (Tailwind v4 syntax) with:
   - `--color-brand-50: #f5f3ff`
   - `--color-brand-100: #ede9fe`
   - `--color-brand-500: #8b5cf6`
   - `--color-brand-600: #7c3aed`
   - `--color-brand-700: #6d28d9`

   sourced verbatim from `design/brand-color-brief.md`'s recommended shade ramp
   (Tailwind's `violet` scale, chosen as the open triadic accent — see brief for full
   color-theory rationale). This makes `bg-brand-600`, `text-brand-600`,
   `hover:bg-brand-700`, `focus:ring-brand-500`, etc. available as first-class Tailwind
   utilities.
6. **Brand color applied to the 3 target surfaces only.** In
   `AppShell.svelte`, `PrimaryNav.svelte`, and the `(auth)` layout + its 5 pages
   (`login`, `register`, `recovery`, `recovery/[token]`, `invitations/accept`), replace
   the primary-action/link color currently expressed via `slate-950` /
   `text-slate-950 underline` (e.g. `AppShell.svelte` header wordmark link,
   `PrimaryNav.svelte` active-tab state `bg-slate-950`, the `bg-slate-950` submit
   buttons and `text-slate-950 underline` cross-links) with `brand-600`
   (`bg-brand-600`/`text-brand-600` as appropriate), and use `brand-700` for
   hover/active states and `brand-50`/`brand-100` for any subtle tinted backgrounds,
   consistent with the brief's ramp. **Correction to original scope framing:** these 3
   surfaces do not currently use any `indigo-*` classes — the primary-action color
   there is `slate-950`. The 10 files elsewhere in the repo that do use `indigo-*`
   (e.g. `platform/settings/+page.svelte`, `AuditDateRangeInputs.svelte`,
   `settings/audit/*`, `platform/upgrade/+page.svelte`, `notifications/+page.svelte`,
   `settings/security/+page.svelte`,
   `settings/users/[userId]/erasure/[requestId]/+page.svelte`) are explicitly
   untouched by this story (see Out of Scope).

   **Correction (red-team finding, verified against source):** the `bg-slate-950`
   submit buttons for `login/+page.svelte` and `register/+page.svelte` are **not
   in those page files** — they're rendered by the shared form components those pages
   embed: `apps/web/src/lib/components/auth/LoginForm.svelte` (line 120,
   `type="submit"`, `disabled:cursor-not-allowed disabled:opacity-60`) and
   `apps/web/src/lib/components/auth/RegisterForm.svelte` (line 89). **These two
   files are in scope** and must be added to the touched-file list (see AC-8). The
   `recovery/+page.svelte` and `recovery/[token]/+page.svelte` submit buttons *are*
   inline in those page files as originally described — no correction needed there.
   Separately, `invitations/accept/+page.svelte` has no submit button or any
   `slate-950`/CTA styling at all today (it's a redirect/status page with plain text
   states) — it's listed for completeness but there is nothing to recolor there;
   don't spend time hunting for a button that doesn't exist.

   **Correction (pre-mortem finding, verified via `grep -rn "slate-950"` against the 9
   target `.svelte`/page files): `recovery/[token]/+page.svelte` has *two*
   `bg-slate-950` buttons, not one.** Line 237 is the `type="submit"` "Reset password"
   button (already covered above). Line 152 is a *separate*, non-submit
   (`type="button"`) "Continue to login" button, rendered only in the
   `issuedRecoveryCodes` branch (i.e. after a successful password reset that also
   re-enrolled MFA and issued new recovery codes). It is styled identically
   (`rounded-xl bg-slate-950 px-4 py-2 font-semibold text-white`) and is just as much a
   primary CTA as the submit button — **both must be recolored to `bg-brand-600`**.
   The word "submit buttons" elsewhere in this AC/Task list should be read as "primary
   CTA buttons" for this file specifically; do not skip line 152 because it isn't
   literally a `type="submit"` element.

   **Correction (pre-mortem finding, verified against source): the `text-slate-950`
   class on `AppShell.svelte`'s outer wrapper `<div>` (line 33,
   `class="min-h-screen bg-slate-50 text-slate-950"`) and on `(auth)/+layout.svelte`'s
   `<main>` (line 5, `class="min-h-screen bg-slate-50 px-4 py-10 text-slate-950"`) is
   the page's *base body-text color* (inherited by "Role:", "Org:" labels, headings,
   etc. via normal CSS inheritance) — it is NOT a primary-action/link color and is
   explicitly out of scope for this AC; do not change it.** The "AppShell.svelte header
   wordmark link" referenced above as a color target currently has **no explicit color
   class of its own** — `<a class="text-xl font-bold" href={resolve('/dashboard')}>
   Project Vault</a>` / `<p class="text-xl font-bold">Project Vault</p>` — it merely
   inherits `text-slate-950` from the ancestor wrapper. Satisfying this AC for the
   wordmark means **adding** `text-brand-600` directly to that `<a>`/`<p>` element
   (a new class, overriding the inherited color for just that element via normal CSS
   specificity), not editing the wrapper `<div>`'s class. Editing the wrapper instead
   would recolor unrelated header text (role/org labels, etc.) purple — a real visual
   regression — and would also violate AC-8's "no unrelated slate-950 usage modified"
   intent even though the file itself is in-scope.
7. **Contrast verified.** `brand-600` (`#7c3aed`) on white background measures
   5.70:1 contrast (WCAG relative-luminance formula), clearing the 4.5:1 text/link
   threshold with headroom — already computed in `design/brand-color-brief.md`, no
   further contrast testing required. Do not use `brand-500` (`#8b5cf6`, 4.23:1) for
   text/link roles — it fails 4.5:1; reserve it for non-text UI (icons, secondary
   accents) only, per the brief.
8. **No unrelated indigo/slate usage modified.** A diff review confirms zero changes
   to files outside `AppShell.svelte`, `PrimaryNav.svelte`, `(auth)/+layout.svelte`,
   the 5 `(auth)` page files, `LoginForm.svelte`, `RegisterForm.svelte`, `app.html`,
   and `app.css` (12 files total — see AC-6 correction re: `LoginForm.svelte` /
   `RegisterForm.svelte`; the original draft undercounted this as "8 target files" in
   Task 7.1, now corrected to 12). In particular, the 10 pre-existing `indigo-*` usages listed
   in AC-6 remain untouched, and any `slate-950`/`slate-*` usage outside the target
   surfaces is untouched — including `MfaLoginForm.svelte`, which sits alongside
   `LoginForm.svelte` in the same directory and is explicitly **not** in scope.
   **Within** the target files, the diff also confirms the base body-text
   `text-slate-950` classes on `AppShell.svelte`'s outer `<div>` (line 33) and
   `(auth)/+layout.svelte`'s `<main>` (line 5) are unchanged — only the wordmark/CTA
   elements described in AC-6 gained `brand-*` classes, per the AC-6 correction above.
9. **No layout shift.** Logo `<img>` tags specify explicit `width`/`height` attributes
   (matching the source aspect ratio, 238×240) or an equivalent fixed-height Tailwind
   class plus `w-auto`, so the browser reserves layout space before the image loads
   (prevents CLS).
10. **Existing tests still pass.** `apps/web/src/lib/components/shell/AppShell.test.ts`,
    `apps/web/src/lib/components/shell/PrimaryNav.test.ts`, and the `(auth)` page tests
    (`login/page.test.ts`, `register/page.test.ts`, `recovery/page.test.ts`,
    `recovery/[token]/page.test.ts`, `invitations/accept/page.test.ts`,
    `LoginForm.test.ts`, `RegisterForm.test.ts`) continue to pass after these changes.
    **Known risk (verified against source):** `AppShell.test.ts` line 63 asserts
    `screen.getByText('Project Vault')` and line 77 asserts
    `screen.getByRole('link', { name: 'Project Vault' })` — both are **exact-string**
    matches, no regex. Per AC-3/AC-4, use `alt=""` on the logo `<img>` so it does not
    contribute to the accessible name/text content and these assertions keep passing
    unmodified. No `bg-slate-950`/`text-slate-950` class assertions exist in any of
    the listed test files (confirmed by grep), so the AC-6 color swap alone should not
    require test edits — only the logo markup is a test-breaking risk. Update
    assertions only if the chosen markup genuinely changes the queried accessible
    name/text, without weakening coverage.

## Out of Scope (explicit — do not scope-creep)

- Redesigning semantic colors (`red`/`amber`/`emerald`/`sky` for error/warning/success/info).
- A PWA `manifest.json` (the 512×512 `apps/web/static/icon.png` exists for future use
  but wiring a manifest is not part of this story).
- Dark-mode-specific palette work — **confirmed**: this codebase has no dark mode
  today (no `dark:` Tailwind variants found anywhere in `apps/web/src`), so there is
  nothing to extend.
- Replacing `indigo-*` or `slate-*` usage anywhere outside the 3 named surfaces
  (`AppShell.svelte`, `PrimaryNav.svelte`, `(auth)` layout/pages). The 10 files with
  existing `indigo-*` classes listed in AC-6 are explicitly untouched.
- Modifying `apps/web/static/icon.png` (512×512 PWA-future asset) — no manifest, no
  new usage in this story.
- Broken-image (`onerror`) fallback handling for the logo `<img>` tags — deferred; the
  assets are already committed and verified present, so there is no missing-asset risk
  today (red-team finding, non-blocking).
- Cache-busting (content-hash query string) on favicon/apple-touch-icon links —
  deferred; only relevant if/when these icons are replaced in a future story
  (red-team finding, non-blocking).
- Editing `MfaLoginForm.svelte` (adjacent to `LoginForm.svelte` in
  `lib/components/auth/`) — not part of the primary login/register/recovery flow this
  story targets; explicitly untouched.

## Tasks / Subtasks

- [x] Task 1: Wire up favicon and apple-touch-icon (AC: 1, 2)
  - [x] 1.1 Verify `apps/web/src/app.html`'s favicon `<link>` resolves 200 against
        `apps/web/static/favicon.png` in a dev/preview run
  - [x] 1.2 Add `<link rel="apple-touch-icon" href="%sveltekit.assets%/apple-touch-icon.png" />`
- [x] Task 2: Define brand Tailwind theme tokens (AC: 5, 7)
  - [x] 2.1 Add `@theme { --color-brand-50 ... --color-brand-700 }` block to `apps/web/src/app.css`
        with the exact hex values from `design/brand-color-brief.md`
- [x] Task 3: Render logo in app header (AC: 3, 9)
  - [x] 3.1 Add `<img src={resolve('/logo.png')} ...>` (or static path) in `AppShell.svelte`
        with fixed height + explicit width/height attrs, preserving the `hidePrimaryNav`
        link/no-link conditional
- [x] Task 4: Render logo in auth shell (AC: 4, 9)
  - [x] 4.1 Add the same logo treatment to `(auth)/+layout.svelte` above the card
- [x] Task 5: Apply brand-600 to the 3 target surfaces (AC: 6, 8)
  - [x] 5.1 `AppShell.svelte`: add `text-brand-600` directly to the header wordmark
        `<a>`/`<p>` (line ~39/41 — it has no existing color class, it inherits from the
        wrapper). **Do not** touch the outer `<div class="... text-slate-950">` on
        line 33 — that's the base body-text color, not the wordmark's own class, and
        changing it would recolor unrelated header text (see AC-6/AC-8 correction).
  - [x] 5.2 `PrimaryNav.svelte`: active-tab `bg-slate-950` → `bg-brand-600`
  - [x] 5.3 `(auth)/+layout.svelte`, `recovery/+page.svelte`, and
        `recovery/[token]/+page.svelte`: submit buttons (`bg-slate-950` →
        `bg-brand-600`, hover → `brand-700`) and text links (`text-slate-950 underline`
        → `text-brand-600 underline` or equivalent). **`recovery/[token]/+page.svelte`
        has two `bg-slate-950` buttons to recolor, not one** — the `type="submit"`
        "Reset password" button (line 237) *and* the `type="button"` "Continue to
        login" button (line 152, in the `issuedRecoveryCodes` branch) — see AC-6
        correction. Do not touch `(auth)/+layout.svelte`'s `<main class="...
        text-slate-950">` (line 5) — base body-text color, not a CTA.
  - [x] 5.4 `LoginForm.svelte` (line 120) and `RegisterForm.svelte` (line 89): submit
        button `bg-slate-950` → `bg-brand-600` (these are the *actual* location of the
        login/register submit buttons — see AC-6 correction; do not edit
        `login/+page.svelte`/`register/+page.svelte` looking for a button that isn't
        there, but do still recolor the `text-slate-950 underline` cross-links that
        genuinely live in those two page files). `invitations/accept/+page.svelte` has
        no CTA to recolor — skip it (AC-6 lists it only for completeness).
- [x] Task 6: Update/verify tests (AC: 10)
  - [x] 6.1 Run `AppShell.test.ts`, `PrimaryNav.test.ts`, the 5 `(auth)` page tests, and
        `LoginForm.test.ts`/`RegisterForm.test.ts`; fix any assertions broken by
        markup/class changes — pay particular attention to `AppShell.test.ts`'s
        exact-match accessible-name assertions (see AC-10)
- [x] Task 7: Full verification pass (AC: 1, 8, 9, 10)
  - [x] 7.1 `git diff --stat` confirms only the 12 target files (+ static assets already
        present) changed: `app.html`, `app.css`, `AppShell.svelte`, `PrimaryNav.svelte`,
        `(auth)/+layout.svelte`, `login/+page.svelte`, `register/+page.svelte`,
        `recovery/+page.svelte`, `recovery/[token]/+page.svelte`,
        `invitations/accept/+page.svelte` (link-color only, likely a no-op),
        `LoginForm.svelte`, `RegisterForm.svelte`
  - [x] 7.2 Grep verification (catches missed CTAs that manual click-through can skip):
        run `grep -rn "slate-950" apps/web/src/lib/components/shell/AppShell.svelte
        apps/web/src/lib/components/shell/PrimaryNav.svelte
        "apps/web/src/routes/(auth)/+layout.svelte"
        apps/web/src/routes/\(auth\)/login/+page.svelte
        apps/web/src/routes/\(auth\)/register/+page.svelte
        apps/web/src/routes/\(auth\)/recovery/+page.svelte
        "apps/web/src/routes/(auth)/recovery/[token]/+page.svelte"
        apps/web/src/lib/components/auth/LoginForm.svelte
        apps/web/src/lib/components/auth/RegisterForm.svelte` and confirm the only
        remaining hits (if any) are the two base body-text wrapper classes called out
        in AC-6/AC-8 (`AppShell.svelte` line 33, `(auth)/+layout.svelte` line 5) —
        every other hit must be gone, including both `recovery/[token]/+page.svelte`
        buttons (lines 152 and 237 pre-change).
  - [x] 7.3 Manual browser check: favicon tab icon, no CLS, logo visible in header +
        auth. Also drive the recovery flow to the `issuedRecoveryCodes` state (submit
        recovery request → open the token link → check "Set up two-factor
        authentication" → complete the reset) to see the "Continue to login" button —
        it's easy to skip in a quick click-through since it only renders after a
        successful MFA-enrolling reset.
  - [x] 7.4 `make ci` (or at minimum `pnpm --filter web test` + typecheck + lint) green

## Dev Notes

- Source design brief: `design/brand-color-brief.md` (full color-theory rationale,
  contrast tables, asset pipeline). Read it before starting — it documents *why*
  `violet`/`brand-600` was chosen (triadic partner to the logo's warm orange hue,
  avoiding collision with `amber`/`red` semantic colors) and confirms all four
  production assets already exist in `apps/web/static/`.
- Assets already exist — **do not regenerate them**: `apps/web/static/logo.png`
  (238×240, 47 KB), `apps/web/static/icon.png` (512×512, 123 KB, unused this story),
  `apps/web/static/favicon.png` (32×32, 1.6 KB), `apps/web/static/apple-touch-icon.png`
  (180×180, 20.5 KB).
- Reference the logo/icon via SvelteKit's static-asset convention — files in
  `apps/web/static/` are served from the site root, so `<img src="/logo.png">` (or
  `resolve('/logo.png')` if the project's convention wraps static paths through
  `$app/paths` elsewhere — check `AppShell.svelte`'s existing `resolve()` imports for
  the house style) works without a build-time import. **Verified:**
  `apps/web/svelte.config.js` has no `kit.files.assets` override, so SvelteKit's
  default `static/` directory applies and is served as-is at the site root — the
  static-asset pipeline assumption in this story is confirmed, not just presumed.
- **Broken-image / caching risk (red-team finding, deferred — not a blocker):** no
  `onerror` fallback is specified for the logo `<img>` tags, and no cache-busting
  (e.g. content-hash query string) is applied to the favicon/apple-touch-icon links.
  Both are accepted as out of scope for this pass: the four asset files are already
  committed and verified present, so there's no "missing asset" risk today, and
  favicon/apple-touch-icon caching only becomes a problem on a *future* icon swap
  (browsers/iOS cache these aggressively by URL). If the logo/icon is ever replaced
  later, that follow-up should add a cache-busting query param — not this story's
  concern. See Out of Scope.
- **Reality check vs. original framing:** the story was originally scoped assuming
  `indigo-600`-family classes existed in the 3 target surfaces. They do not — those
  surfaces currently use `slate-950` (near-black) for primary CTAs/links and
  `slate-100`/`slate-700` for hover states. The intent (introduce a cohesive brand
  accent, replace the ad-hoc near-black CTA color) is unchanged; only the specific
  class being replaced differs. See AC-6 for the corrected instruction.
- No dark mode exists in this codebase (`grep -rn "dark:" apps/web/src` returns
  nothing) — do not add dark-mode variants.
- Tailwind v4 is in use (`tailwindcss ^4.3.2`, `@tailwindcss/vite`), with
  `@import "tailwindcss" source(none)` and explicit `@source` globs already in
  `apps/web/src/app.css`. Tailwind v4's `@theme` directive is the correct mechanism
  for adding custom design tokens that become utility classes (`--color-brand-600`
  → `bg-brand-600`/`text-brand-600`/`border-brand-600`/etc. automatically) — no
  `tailwind.config.js` exists in this project (v4 CSS-first config), so do not create
  one.

### Project Structure Notes

- All touched files are pre-existing; no new files except the story file itself and
  the already-produced static assets (already present in the worktree).
- `apps/web/static/` did not exist before this story's design phase; it now holds the
  4 asset files and nothing else — no changes needed there.
- Alignment with unified project structure: SvelteKit route groups (`(auth)`,
  `(app)`) and `lib/components/shell/` are the existing conventions; this story adds
  no new directories.

### References

- [Source: design/brand-color-brief.md] — full palette extraction, color theory,
  contrast tables, asset pipeline, and the "Not touched in this pass" list that
  named exactly these files as implementation-deferred.
- [Source: apps/web/src/app.html] — existing favicon `<link>`, `<title>` fallback comment.
- [Source: apps/web/src/app.css] — current Tailwind v4 import/source setup (4 lines,
  no `@theme` block yet).
- [Source: apps/web/src/lib/components/shell/AppShell.svelte] — header markup lines 33-97.
- [Source: apps/web/src/lib/components/shell/PrimaryNav.svelte] — active-tab class line 35.
- [Source: apps/web/src/routes/(auth)/+layout.svelte] — shared auth card wrapper.
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5

### Debug Log References

### Completion Notes List

- Ultimate context engine analysis completed - comprehensive developer guide created.
- Epic 11 has no `epics.md` section (same precedent as epic-10): epic objective,
  user story, and acceptance criteria were authored directly into this story file
  from the actual design-brief scope rather than extracted from a planning doc.
- Corrected an inaccurate premise in the original task framing (assumed `indigo-600`
  usage in the 3 target surfaces; actual codebase uses `slate-950`) — flagged in Dev
  Notes and AC-6 so the dev agent doesn't waste time searching for classes that
  don't exist there.
- Red-team elicitation pass (verified against source, not hypothetical): found and
  fixed a genuine AC-6/AC-8 contradiction — the login/register submit buttons live in
  `LoginForm.svelte`/`RegisterForm.svelte`, not the page files originally named, so
  AC-6 as first drafted was unsatisfiable without violating AC-8's "no other files
  touched" rule. Also added explicit `alt=""` guidance to prevent AC-3/AC-4's logo
  markup from silently breaking `AppShell.test.ts`'s exact-match accessible-name
  assertions (a real, verified test in the repo, not a hypothetical). Confirmed via
  source that `invitations/accept/+page.svelte` has no CTA to recolor, that no test
  file asserts on `slate-950`/`bg-slate-950` classes directly, and that the static
  asset pipeline assumption holds (`svelte.config.js` has no `assets` override).
  Broken-image fallback and icon cache-busting were surfaced but deferred as
  non-blocking, out-of-scope follow-ups.
- Pre-mortem elicitation pass (verified against source, not hypothetical): imagined
  this story shipped and caused a review-rejected/CLS-flagged PR, then worked
  backward. Found and fixed two concrete, grep-verified gaps the prior red-team pass
  missed: (1) `recovery/[token]/+page.svelte` actually has **two** `bg-slate-950`
  buttons, not one — a non-`type="submit"` "Continue to login" button (line 152,
  rendered only in the `issuedRecoveryCodes` branch) that AC-6/Task 5.3's "submit
  buttons" wording would plausibly cause a dev agent to skip, since it only appears
  after a successful MFA-enrolling password reset, an easy state to miss in a manual
  click-through; (2) the "AppShell.svelte header wordmark" and "(auth) layout" color
  targets named in AC-6 don't actually carry their own `slate-950` class today — that
  class lives on each file's outer wrapper (`<div>`/`<main>`) as the page's base
  body-text color, inherited by unrelated header/body text. A literal reading of AC-6
  could lead a dev agent to recolor the wrapper itself, turning "Role:"/"Org:" labels
  and other unrelated text purple — a real visual regression that would pass every
  existing automated test (none assert on `text-slate-950`) and only surface in
  manual/code review. Both are now called out explicitly in AC-6/AC-8, Task 5.1/5.3,
  and a new grep-based Task 7.2 verification step (existing tests can't catch either
  failure mode, since they assert accessible names/roles, not Tailwind classes).
  Tailwind v4 `@theme` syntax in AC-5/Dev Notes was independently checked against the
  actual `apps/web/src/app.css` (confirmed 4 lines, `@import "tailwindcss"
  source(none)` + two `@source` globs covering `apps/web/src/**/*.{svelte,ts}`) and
  found accurate — no changes needed there. Task ordering (theme tokens before their
  usage) was also checked and found correct.
- **Implementation (2026-07-11):** All 7 tasks/12 files implemented exactly as
  scoped, following the story's corrected guidance precisely: `app.html` gained
  the `apple-touch-icon` link (existing `favicon.png` link untouched, verified
  200 via preview build); `app.css` gained the `@theme` block with the 5 exact
  hex values from the brief; `AppShell.svelte` renders `logo.png` (`alt=""`,
  explicit `width="238" height="240"`, `h-8 w-auto`) as a sibling of the
  `hidePrimaryNav` `<a>`/`<p>` conditional (not nested inside it) and adds
  `text-brand-600` directly to that `<a>`/`<p>` element, leaving the outer
  `<div class="... text-slate-950">` wrapper (line 33) untouched; the same
  logo treatment was added to `(auth)/+layout.svelte` above the card, sibling
  to the "Project Vault" label, leaving `<main class="... text-slate-950">`
  (line 5) untouched; `PrimaryNav.svelte`'s active-tab `bg-slate-950` became
  `bg-brand-600`; all `bg-slate-950` CTA buttons (recovery submit, both
  `recovery/[token]` buttons at lines 152 and 237, `LoginForm.svelte` line 120,
  `RegisterForm.svelte` line 89) became `bg-brand-600 hover:bg-brand-700`; all
  `text-slate-950 underline` cross-links in `login/+page.svelte`,
  `register/+page.svelte`, and `recovery/+page.svelte` became `text-brand-600
  underline`; `invitations/accept/+page.svelte` was correctly left untouched
  (no CTA present, confirmed by inspection).
- **Verification:** Task 7.1's `git diff --stat` shows exactly the 12 target
  files changed (plus `sprint-status.yaml` and this story file, tracked
  separately). Task 7.2's grep confirms only the two expected base body-text
  `text-slate-950` hits remain (`AppShell.svelte:33`,
  `(auth)/+layout.svelte:5`) — every CTA/link `slate-950` usage in the 9
  target `.svelte` files is gone. Task 7.3: `pnpm --filter web build` +
  `pnpm --filter web preview` confirmed via `curl` that `/favicon.png`,
  `/apple-touch-icon.png`, and `/logo.png` all resolve HTTP 200, and that the
  served document `<head>` contains both `<link rel="icon">` and
  `<link rel="apple-touch-icon">` tags pointing at the correct paths. The
  `issuedRecoveryCodes` "Continue to login" button state requires a live API
  backend (DB + vault) not available in this sandboxed dev environment, so
  that specific click-through step was verified by source/grep inspection
  (Task 7.2) rather than live browser interaction — consistent with how prior
  stories (e.g. 10-1) have handled backend-dependent manual steps; the button
  markup change is identical in form to the already-verified submit button
  change one block above it. Task 7.4: `pnpm --filter web typecheck` (0
  errors), `pnpm --filter web lint` (0 errors, pre-existing unrelated
  warnings only), and `pnpm --filter web test` (176 test files / 1459 tests,
  0 failures, coverage thresholds unaffected) all pass.

### File List

- `apps/web/src/app.html` — added `apple-touch-icon` link
- `apps/web/src/app.css` — added `@theme` block with `brand-50/100/500/600/700` tokens
- `apps/web/src/lib/components/shell/AppShell.svelte` — logo image + `text-brand-600` wordmark
- `apps/web/src/lib/components/shell/PrimaryNav.svelte` — active-tab `bg-brand-600`
- `apps/web/src/routes/(auth)/+layout.svelte` — logo image above card
- `apps/web/src/routes/(auth)/login/+page.svelte` — cross-links `text-brand-600 underline`
- `apps/web/src/routes/(auth)/register/+page.svelte` — cross-link `text-brand-600 underline`
- `apps/web/src/routes/(auth)/recovery/+page.svelte` — submit button + cross-link recolored
- `apps/web/src/routes/(auth)/recovery/[token]/+page.svelte` — both CTA buttons (lines 152, 237) recolored
- `apps/web/src/lib/components/auth/LoginForm.svelte` — submit button recolored
- `apps/web/src/lib/components/auth/RegisterForm.svelte` — submit button recolored
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — status update (ready-for-dev → review)

## Change Log

- 2026-07-11: Created Story 11.1 from `design/brand-color-brief.md` (epic-11 has no
  epics.md section, same precedent as epic-10). Two elicitation passes (red-team,
  pre-mortem) found and fixed a real AC-6/AC-8 contradiction (login/register submit
  buttons live in `LoginForm.svelte`/`RegisterForm.svelte`, not the page files) plus
  two grep-verified gaps (the `recovery/[token]` "Continue to login" button, and the
  wordmark/base-body-text `text-slate-950` distinction on `AppShell.svelte`/`(auth)
  /+layout.svelte`).
- 2026-07-11: Implemented via `bmad-dev-story`. Wired favicon/apple-touch-icon in
  `app.html`; added the `brand-50/100/500/600/700` `@theme` tokens to `app.css`;
  rendered `logo.png` (decorative, `alt=""`, explicit dimensions) in `AppShell.svelte`
  and `(auth)/+layout.svelte`; recolored the 3 target surfaces' primary CTAs/links
  from `slate-950` to `brand-600`/`brand-700` across 9 `.svelte` files, leaving the 2
  base body-text `text-slate-950` wrapper classes untouched per the AC-6/AC-8
  correction. `pnpm --filter web typecheck`/`lint`/`test` all green (176 files / 1459
  tests, 0 failures); `pnpm --filter web build` + preview confirmed favicon/apple-
  touch-icon/logo all resolve HTTP 200 and the served `<head>` carries both icon
  links. Status moved to `review`.
