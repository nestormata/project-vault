import semver from 'semver'
import type { ExtensionDbScopeEntry } from './db-access.js'

/**
 * AC1 — the manifest shape an extension author declares, per architecture.md
 * § Extension Manifest Shape.
 */
export type ExtensionCapability =
  | 'auth-provider'
  | 'notification-channel'
  | 'ui-panel'
  | 'capability-gate'
  | 'audit-event-source'
  | 'project-lifecycle'
  // Story 20.11 AC1 — declares that this extension's `hooksFactory()` may return a
  // `deliveryProvider` hooks-bag entry (see `register-extension.ts`'s `ExtensionHooks`).
  | 'delivery-provider'

export type ExtensionManifest = {
  /** Reverse-DNS-style identifier, e.g. "com.acme.sso-extension" — validated by registerExtension (AC6). */
  name: string
  /** Exact canonical EXTENSION_API_VERSION this extension was built against (e.g. "1.0.0"). Ranges and wildcards are rejected; "1.0.0" is accepted and "^1.0.0" is rejected. */
  apiVersion: string
  capabilities: ExtensionCapability[]
  /**
   * Story 23.2 AC-2 — optional declaration that this extension's `authStrategy` hook fully
   * replaces the host's native (password) login. Omitted or `false` is byte-identical to every
   * extension shipped before this field existed: native login stays enabled. `true` is only one
   * of three facts the host requires before it will ever disable native login (see
   * `apps/api/src/modules/auth/native-login-policy.ts`'s `replacementDeclared` /
   * `replacementProven` distinction) — declaring this field alone never disables anything.
   */
  replacesNativeLogin?: boolean
  /** Optional, operator-approved request for a separate least-privilege DB handle. */
  dbScope?: ExtensionDbScopeEntry[]
  /**
   * Story 25.2 AC1 — optional declaration of the named panel slots this extension owns/serves.
   * Omitted (or `undefined`) is fully backward-compatible: the host falls back to the exact
   * single-slot ('group') behavior Story 25.1 shipped (see AC2 and
   * `apps/api/src/lib/extension-panel.ts`'s `resolveKnownUiPanelSlots`). When present, must be a
   * non-empty array of unique strings each matching `UI_PANEL_SLOT_NAME_PATTERN`, capped at
   * `MAX_UI_PANEL_SLOTS` entries, and only legal alongside `'ui-panel'` in `capabilities[]` —
   * validated by `registerExtension()`'s `validateUiPanelSlotsShape`.
   */
  uiPanelSlots?: string[]
  /**
   * Story 25.5 AC2 — optional declaration of the action `kind`s this extension's `moduleAction`
   * hook accepts via `POST /extensions/panels/:slot/actions`. Mirrors `uiPanelSlots`' exact
   * validation shape (non-empty array of unique strings, charset-bounded, capped length) but is a
   * separate, differently-named namespace (`MODULE_ACTION_NAME_PATTERN`, not
   * `UI_PANEL_SLOT_NAME_PATTERN`) — action names and slot names must never be conflated even
   * though their validation shape is identical. Omitted (or `undefined`) is fully
   * backward-compatible: the host serves zero declared actions, every action request 404s.
   * Only legal alongside `'ui-panel'` in `capabilities[]` — validated by `registerExtension()`'s
   * `validateModuleActionsShape()`.
   */
  moduleActions?: string[]
  /**
   * Story 25.12 AC2 — optional declaration of the PV-native REST path templates the DATA relay
   * (`+page.svelte`'s `PANEL_DATA_REQUEST_SOURCE` handler) will forward on this extension's
   * behalf. Omitted (or `undefined`) is fully backward-compatible: the host falls back to the
   * exact pre-existing hardcoded pair (`DEFAULT_PANEL_DATA_PATHS`,
   * `apps/api/src/lib/extension-panel.ts`) — `/api/v1/projects` and `/api/v1/projects/:id` — with
   * a one-time warn log (mirroring `uiPanelSlots`' own fallback discipline). Each entry is a path
   * TEMPLATE, not a regex: `/`-separated segments, each either a literal `[a-z0-9-]+` token or a
   * `:param` placeholder, the whole template required to start with the literal prefix
   * `/api/v1/` — validated by `registerExtension()`'s `validatePanelDataPathsShape()`. Only legal
   * alongside `'ui-panel'` in `capabilities[]`. Unlike `uiPanelSlots`/`moduleActions`, this field
   * has NO `hooksFactory()`-callability cross-check — it gates a client-relay allowlist, not a
   * hook's existence (Story 25.12 AC3).
   *
   * @deprecated Story 29.4 — superseded by `moduleDataRoutes`, which mounts real Fastify routes
   * directly on PV's own API router instead of relaying through the (now-deleted) DATA relay.
   * Kept, unused, purely to avoid an unplanned MAJOR `EXTENSION_API_VERSION` bump for removing a
   * public type field (see Story 29.4 AC8's Dev Notes) — every consumer of this field has been
   * deleted; only the type/validator survive.
   */
  panelDataPaths?: string[]
  /**
   * Story 29.3 AC1 — optional declaration of top-level (and one-level-nested) navigation entries
   * this extension contributes to PV's own primary nav. Deliberately NOT gated behind the
   * `'ui-panel'` capability, unlike every other optional array field above (`uiPanelSlots`/
   * `moduleActions`/`panelDataPaths`): those fields are specifically about the UI-panel
   * *rendering* mechanism, while a nav entry is a general-purpose capability — a link to anywhere
   * in PV, potentially contributed by an extension that only implements `'auth-provider'` or
   * `'notification-channel'`. Do not "fix" this into matching the other fields' capability gate;
   * this divergence is intentional (see this story's Dev Notes). Omitted (or `undefined`) is
   * fully backward-compatible: the host renders zero extension-contributed nav entries. When
   * present, must be a non-empty array of unique-`id` items, capped at `MAX_NAV_ITEMS`, each
   * validated by `registerExtension()`'s `validateNavItemsShape()` — see that function for the
   * exact id/href/icon/label/parentId rules (AC2-AC6).
   */
  navItems?: ExtensionNavItem[]
  /**
   * Story 29.4 AC1 — optional declaration of real `GET` routes this extension wants mounted
   * directly on PV's own Fastify API router, under the fixed host-owned prefix
   * `/api/v1/extensions/data` (AC2). Replaces the retired `panelDataPaths`/DATA-relay mechanism:
   * an undeclared path simply doesn't exist as a route (a `404`, not a relay-level rejection).
   * Each entry's `path` does NOT require the `/api/v1/` prefix `panelDataPaths` templates
   * required — the host itself chooses and owns the full mount point, so there is nothing for
   * the manifest-declared path to escape or collide with. Omitted (or `undefined`) is fully
   * backward-compatible: zero module-data routes are mounted. Validated by `registerExtension()`'s
   * `validateModuleDataRoutesShape()`, and cross-checked against `ExtensionHooks.moduleData` post-
   * `hooksFactory()` (AC3) — every declared route must have a matching callable handler.
   */
  moduleDataRoutes?: ModuleDataRouteDeclaration[]
}

/**
 * Story 29.4 AC1 — a single manifest-declared module-data route. `method` is currently always the
 * literal `'GET'` (not a union) — this story is scoped to the data-fetch half of ADR 0005's
 * addendum item 3; a future story may widen this to other read-shaped methods. `path` is a
 * `/`-separated route path (Fastify-native `:param` syntax, no translation needed) matching
 * `MODULE_DATA_ROUTE_PATH_PATTERN`.
 */
export type ModuleDataRouteDeclaration = {
  method: 'GET'
  path: string
}

/**
 * Story 29.3 AC1 — a single manifest-declared nav entry. `parentId`, when present, must reference
 * another `id` in the SAME `navItems` array (exactly one level of nesting — a child may not itself
 * be a parent, AC3). `label` renders via ordinary Svelte text interpolation (auto-escaped, never
 * `{@html}`) and is never routed through Paraglide — it is the extension author's own text, not
 * the host's to translate (AC4). `href` is validated as a same-origin relative path (AC5) because
 * it is rendered as a live, unsanitized `<a href>` attribute. `icon`, when present, must be one of
 * `NAV_ITEM_ICON_TOKENS` — a closed set the host owns and maps to its own glyphs, never freeform
 * markup or a URL (AC6).
 */
export type ExtensionNavItem = {
  id: string
  label: string
  href: string
  icon?: NavItemIconToken
  parentId?: string
}

/**
 * Story 29.3 AC6 — the closed set of icon tokens a manifest-declared `navItems` entry's `icon`
 * field may use. The host maps each token to one of its own pre-existing icon glyphs at render
 * time; no SVG, image URL, or other extension-supplied visual content is ever accepted. Extending
 * this set is a deliberate, additive-minor `EXTENSION_API_VERSION` change — never a freeform
 * string, even for a "just this once" new extension request (see this story's Dev Notes).
 */
export const NAV_ITEM_ICON_TOKENS = ['puzzle-piece', 'link', 'grid'] as const
export type NavItemIconToken = (typeof NAV_ITEM_ICON_TOKENS)[number]

/**
 * Story 25.2 AC1 — the charset a declared `uiPanelSlots` entry must match. Lowercase
 * alphanumerics and hyphens only, 1-64 chars: excludes `/`, `.`, and every other structural
 * character by construction, closing the path-traversal/route-confusion angle considered during
 * this story's own Red Team vs Blue Team elicitation round without any extra code. This is new
 * code (see AC1's Assumption Audit correction) — Story 25.1's request-side `slot` check is a
 * plain exact-match against `knownSlots`, not a standalone regex.
 */
export const UI_PANEL_SLOT_NAME_PATTERN = /^[a-z0-9-]{1,64}$/

/** Story 25.2 AC1 — generous for any real extension, small enough to bound a hostile/broken
 * manifest from declaring an unbounded `uiPanelSlots` list. */
export const MAX_UI_PANEL_SLOTS = 32

/**
 * Story 25.5 AC2 — the charset a declared `moduleActions` entry must match. Identical shape to
 * `UI_PANEL_SLOT_NAME_PATTERN` (lowercase alphanumerics and hyphens only, 1-64 chars) but a
 * separately-named constant — action names and slot names are different namespaces and must not
 * be conflated even though the validation shape is identical.
 */
export const MODULE_ACTION_NAME_PATTERN = /^[a-z0-9-]{1,64}$/

/** Story 25.5 AC2 — generous for any real extension, small enough to bound a hostile/broken
 * manifest from declaring an unbounded `moduleActions` list. */
export const MAX_MODULE_ACTIONS = 32

/**
 * Story 25.12 AC2 — validates an entire `panelDataPaths` entry (a path TEMPLATE, not a bare
 * name) in one pass: must start with the literal prefix `/api/v1/`, followed by one or more
 * `/`-separated segments, each either a literal token matching `[a-z0-9-]+` or a parameter
 * placeholder matching `:[a-zA-Z][a-zA-Z0-9]*`. The literal-segment charset excludes `.`/`/`,
 * closing the same path-traversal/route-confusion angle `UI_PANEL_SLOT_NAME_PATTERN` already
 * closes for slot names — a template segment can never contain `..` or an embedded `/`. The two
 * quantified alternatives inside each segment group match disjoint character sets (`[a-z0-9-]`
 * vs. a leading `:`), and segments themselves are separated by a literal `/`, so there is no
 * ambiguous overlap for catastrophic backtracking.
 */
// eslint-disable-next-line security/detect-unsafe-regex -- see rationale in the comment above; charset is bounded and non-overlapping across each segment's two alternatives
export const PANEL_DATA_PATH_PATTERN = /^\/api\/v1(?:\/(?:[a-z0-9-]+|:[a-zA-Z][a-zA-Z0-9]*))+$/

/** Story 25.12 AC2 — generous for any real extension, small enough to bound a hostile/broken
 * manifest from declaring an unbounded `panelDataPaths` list. Matches `MAX_UI_PANEL_SLOTS`/
 * `MAX_MODULE_ACTIONS`'s precedent exactly. */
export const MAX_PANEL_DATA_PATHS = 32

/**
 * Story 29.3 AC2 — the charset a declared `navItems[].id` entry must match. Identical shape to
 * `UI_PANEL_SLOT_NAME_PATTERN`/`MODULE_ACTION_NAME_PATTERN` (lowercase alphanumerics and hyphens
 * only, 1-64 chars) but a separately-named constant — a different namespace, same shape, never
 * conflated with slot/action names.
 */
export const NAV_ITEM_ID_PATTERN = /^[a-z0-9-]{1,64}$/

/**
 * Story 29.3 AC5 — `href` must be a same-origin relative path: starts with exactly one `/`, no
 * scheme, no `//` protocol-relative prefix, no whitespace/control characters. This is a real
 * security control, not decoration: an extension-declared `href` renders as a live, unsanitized
 * `<a href>` attribute with zero sanitization step in between (unlike DOMPurify-sanitized panel
 * HTML) — a typo'd `javascript:`/`data:` scheme or an absolute URL would otherwise be a real,
 * clickable link the browser executes/navigates on click.
 *
 * Code-review fix (2026-08-29): the leading `(?!\/)` negative lookahead is load-bearing, not
 * decorative — without it, `[a-zA-Z0-9/_-]*` after the first `/` happily matches a SECOND `/`,
 * so a dot-free protocol-relative href like `//evilhost` (a single-label hostname, resolvable via
 * DNS search suffix/`/etc/hosts` on plenty of networks) previously passed this pattern despite
 * AC5's explicit "no `//` protocol-relative prefix" requirement. The existing regression test only
 * ever exercised `//evil.example.com`, which happened to be rejected for an unrelated reason (`.`
 * is not in the allowed charset) and never verified the actual protocol-relative-prefix rule.
 */
export const NAV_ITEM_HREF_PATTERN = /^\/(?!\/)[a-zA-Z0-9/_-]*$/

/** Story 29.3 AC2 — generous for any real extension, small enough to bound a hostile/broken
 * manifest from declaring an unbounded `navItems` list. Matches `MAX_UI_PANEL_SLOTS`/
 * `MAX_MODULE_ACTIONS`/`MAX_PANEL_DATA_PATHS`'s identical cap precedent. */
export const MAX_NAV_ITEMS = 32

/**
 * Story 29.4 AC1 — validates a declared `moduleDataRoutes[].path`: identical per-segment grammar
 * to `PANEL_DATA_PATH_PATTERN` (each segment either a literal `[a-z0-9-]+` token or a `:param`
 * placeholder matching `:[a-zA-Z][a-zA-Z0-9]*`), but WITHOUT that pattern's `/api/v1/` prefix
 * requirement (AC2 — the host itself owns the full mount point via a fixed prefix it prepends,
 * never something the manifest can influence). The closed charset structurally cannot express a
 * traversal segment, mirroring `UI_PANEL_SLOT_NAME_PATTERN`/`PANEL_DATA_PATH_PATTERN`'s own
 * already-established "closed charset closes the traversal angle for free" precedent.
 */
// eslint-disable-next-line security/detect-unsafe-regex -- see PANEL_DATA_PATH_PATTERN's identical rationale above; charset is bounded and non-overlapping across each segment's two alternatives
export const MODULE_DATA_ROUTE_PATH_PATTERN = /^(?:\/(?:[a-z0-9-]+|:[a-zA-Z][a-zA-Z0-9]*))+$/

/** Story 29.4 AC1 — generous for any real extension, small enough to bound a hostile/broken
 * manifest from declaring an unbounded `moduleDataRoutes` list. Matches `MAX_UI_PANEL_SLOTS`/
 * `MAX_MODULE_ACTIONS`/`MAX_PANEL_DATA_PATHS`/`MAX_NAV_ITEMS`'s identical cap precedent. */
export const MAX_MODULE_DATA_ROUTES = 32

/** Story 29.3 AC4 — `label` is raw, host-rendered display text (auto-escaped by Svelte's ordinary
 * text interpolation, never `{@html}`); this cap bounds a hostile/broken manifest from declaring
 * an unreasonably long nav label, not a security control in itself. */
export const MAX_NAV_ITEM_LABEL_LENGTH = 128

/**
 * AC1/AC7 — this package's own contract version. Must be bumped in lockstep with any change
 * under `src/**` (enforced by `scripts/check-extension-api-version-skew.ts`, AC7) and kept equal
 * to this package's `package.json` `version` field (see `manifest.test.ts`).
 */
// Story 23.11 AC6 — bumped as a genuine BREAKING major (2.2.0 -> 3.0.0), not additive-minor:
// removing `organizationId` from `OrgAuthorizationCheckContext` is safe at the JS-structural
// level but not at the TypeScript level for an existing caller that passes an inline object
// literal (excess-property check rejects the now-unknown field at compile time). See this
// story's Dev Notes/PR description for the coordinated centralizeme-sass follow-up this requires.
// Story 25.2 AC1/Task 1 — bumped as an additive-minor (3.0.0 -> 3.1.0), not a major: the new
// optional `uiPanelSlots` field is backward-compatible by construction (AC2's fallback), and
// `HOST_SUPPORTED_EXTENSION_API_RANGE`'s floor stays `>=3.0.0`, so CM's real, currently-shipped
// manifest (declared exact version "3.0.0") keeps loading with zero coordinated cross-repo
// change required — confirmed against `isAboveHostButSameMajor`/the range's actual floor/ceiling
// logic (see this story's Dev Notes Pre-mortem Analysis).
// Story 25.3 AC1/Task 1 — bumped as an additive-minor (3.1.0 -> 3.2.0) and merged to main first:
// `UIPanelContext` gains `resourceId?`, `identity`, `orgId`, `projectId?`, `locale`, `theme` (see
// `hooks/ui-panel.ts`). TypeScript's bivariant parameter checking for method-shorthand object
// literals (`onRenderPanel(context) {...}`) means an existing extension's narrower-typed
// implementation stays structurally assignable to the widened `UIPanel` type without a
// coordinated update — confirmed during this story's own Pre-mortem Analysis elicitation round —
// so an additive-minor bump (not a major) remains correct.
// Story 25.4 AC4/Task 4 — this branch independently bumped 3.1.0 -> 3.2.0 too (developed in
// parallel with 25.3, before either merged), for its own additive-minor change: the new
// `EXTENSION_THEME_CSS_VARS`/`ExtensionThemeCssVar` theming-contract exports (theme-contract.ts)
// are a brand-new, purely-additive export set an extension opts into via
// `var(--pv-ext-*, fallback)` — nothing existing changes shape. Because Story 25.3 already landed
// on `main` claiming 3.2.0 for a *different* additive change before this branch merged,
// `scripts/check-extension-api-version-skew.ts`'s forward-only-versioning invariant (versions are
// allocated at merge, not at planning — Story 23.6) requires this merge to move to the next free
// number instead of reusing 3.2.0: 3.2.0 -> 3.3.0. The floor stays `>=3.0.0` so every
// already-shipped extension keeps loading unmodified regardless. This landed on `main` first.
// Story 25.5 AC2/Task 1 — this branch independently bumped 3.2.0 -> 3.3.0 too (developed in
// parallel with 25.4, before either merged), for its own additive-minor change: `ExtensionManifest`
// gains `moduleActions?: string[]`, `ExtensionHooks` gains `moduleAction?`, and `UIPanelContext`
// gains `actionEndpoint?` (see `hooks/module-action.ts`, `hooks/ui-panel.ts`) — all
// backward-compatible optional additions, no existing extension's manifest or hook shape changes.
// Because Story 25.4 already landed on `main` claiming 3.3.0 first (see above), merging this
// branch's independent 3.3.0 claim requires moving to the next free number instead of reusing it:
// 3.3.0 -> 3.4.0. The floor stays `>=3.0.0` so every already-shipped extension keeps loading
// unmodified regardless.
// Story 20.8 AC-13 — bumped as an additive-minor (3.6.0 -> 3.7.0): `HostServices` gains a new
// required `ephemeralState: EphemeralStateHost` field (see `hooks/ephemeral-state.ts`). Per
// docs/extension-api-versioning-policy.md's classification table, a new field PV *passes to* the
// extension (never one the extension itself must implement) is non-breaking even though the field
// is required on the type — an existing `hooksFactory` that destructures only
// `{ auditEventSource }` (or `{ auditEventSource, orgAuthorization }`) from the widened
// `HostServices` object it's handed at runtime remains structurally compatible and continues to
// run unmodified (TypeScript's structural typing simply ignores the extra field it never reads).
// Still bumped per this codebase's forward-only-versioning invariant, matching the 3.6.0
// precedent (Story 25.9) for a host-side-only, no-extension-code-change addition.
// Story 25.12 AC2/Task 2 — bumped as an additive-minor (3.7.0 -> 3.8.0): `ExtensionManifest`
// gains `panelDataPaths?: string[]`, a purely-additive optional field with a documented
// backward-compatible fallback (`DEFAULT_PANEL_DATA_PATHS`) when omitted — no existing
// extension's manifest shape changes, and the floor stays `>=3.0.0` so every already-shipped
// extension keeps loading unmodified regardless.
// Story 29.3 AC8/Task 1 — bumped as an additive-minor (3.8.0 -> 3.9.0): `ExtensionManifest`
// gains `navItems?: ExtensionNavItem[]`, a purely-additive optional field with no effect on any
// manifest that omits it — no existing extension's manifest shape changes, and the floor stays
// `>=3.0.0` so every already-shipped extension (including any real, currently-deployed
// CentralizeMe build) keeps loading unmodified regardless. Confirmed against `main` at
// implementation time: 3.8.0 was still the latest claimed version, so 3.9.0 was free.
// Story 29.4 AC6/Task 1 — bumped as an additive-minor (3.9.0 -> 3.10.0): `ExtensionManifest`
// gains `moduleDataRoutes?: ModuleDataRouteDeclaration[]` and `ExtensionHooks` gains
// `moduleData?: Record<string, ModuleDataRouteHandler>`, both purely-additive optional fields
// with zero effect on any manifest/hooksFactory that omits them — no existing extension's
// manifest or hook shape changes, and the floor stays `>=3.0.0` so every already-shipped
// extension (including any real, currently-deployed CentralizeMe build) keeps loading unmodified
// regardless. `panelDataPaths` is deprecated-in-place (every consumer deleted, the type field
// itself kept) specifically to avoid an unplanned MAJOR bump for removing a public type field
// (Story 23.11 AC6 precedent). Confirmed against `main` at implementation time: 3.9.0 was still
// the latest claimed version, so 3.10.0 was free.
// Story 20.11 AC1 — bumped as an additive-minor (3.10.0 -> 3.11.0): `ExtensionCapability` gains
// the `'delivery-provider'` literal and `ExtensionHooks` gains `deliveryProvider?: Record<string,
// DeliveryProvider>` (see `hooks/delivery-provider.ts`), both purely-additive optional additions
// with zero effect on any manifest/hooksFactory that omits them — no existing extension's
// manifest or hook shape changes, and the floor stays `>=3.0.0` so every already-shipped
// extension (including any real, currently-deployed CentralizeMe build) keeps loading unmodified
// regardless.
export const EXTENSION_API_VERSION = '3.11.0'

/**
 * Host-authoritative compatibility range. The extension declares the version it was built
 * against; the host declares which versions it accepts. The major floor preserves the
 * breaking-change boundary, while the ceiling prevents a host from loading an extension built
 * against APIs it has not shipped. See docs/extension-api-versioning-policy.md § Load-time gate
 * for the residual risks and rollback escape hatch. Reversing this direction is a security
 * regression, not a stylistic preference.
 */
export const HOST_SUPPORTED_EXTENSION_API_RANGE = `>=${semver.major(EXTENSION_API_VERSION)}.0.0 <=${EXTENSION_API_VERSION}`

/**
 * AC1/AC3 (Task 3) — thin, typed identity function. Gives extension authors autocomplete and
 * type-checking on their manifest object without any runtime effect; validation happens later,
 * at `registerExtension()` time.
 */
export function defineExtension(manifest: ExtensionManifest): ExtensionManifest {
  return manifest
}
