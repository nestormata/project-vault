# Changelog

The contract hash covers the checked-in public API surface and contract-behaviour snapshots.

## 3.10.0 — 2026-08-29

contract-hash: sha256:ee971b28e6d7678640588edca361890559baa317a726e70f06cba4a992c548d6

### Added

- Added `ExtensionManifest.moduleDataRoutes?: ModuleDataRouteDeclaration[]` (Story 29.4 AC1/AC2),
  an optional declaration of real `GET` routes a module wants mounted directly on PV's own
  Fastify API router under a fixed, host-owned `/api/v1/extensions/data` prefix — sharing PV's
  own `secureRoute()` auth/session/rate-limit middleware, unlike the postMessage relay it
  replaces. Each declared route is cross-checked at `registerExtension()` time against
  `ExtensionHooks.moduleData` for hooksFactory()-callability, mirroring `moduleActions`'/
  `uiPanelSlots`' existing discipline. Omitted (or `undefined`) is fully backward-compatible: no
  data routes are mounted.
- Added `ExtensionHooks.moduleData?: Record<string, ModuleDataRouteHandler>` (Story 29.4 AC3), the
  per-route handler map a module's `hooksFactory()` returns; a handler's failure degrades via the
  same `raceWithTimeout()`/`RENDER_PANEL_TIMEOUT_MS` primitive `renderExtensionPanel()` already
  uses, to a fixed non-leaking 502 plus a new `EXTENSION_MODULE_DATA_ROUTE_FAILED` operational-log
  event (Story 29.4 AC5).
- Added `MODULE_DATA_ROUTE_PATH_PATTERN` and `MAX_MODULE_DATA_ROUTES` (Story 29.4 AC1/AC2), the
  path-template charset validation and 32-entry cap for `moduleDataRoutes`, matching
  `PANEL_DATA_PATH_PATTERN`/`MAX_PANEL_DATA_PATHS`'s precedent.

### Deprecated

- Deprecated `ExtensionManifest.panelDataPaths?: string[]` (Story 25.12, added in 3.8.0) —
  superseded by `moduleDataRoutes`, which mounts real Fastify routes instead of relying on a
  postMessage-relayed hardcoded path allowlist. Every server- and client-side consumer of
  `panelDataPaths`/`allowedDataPaths` (the DATA relay in `+page.svelte`, `resolvePanelDataPaths`,
  `DEFAULT_PANEL_DATA_PATHS`) has been deleted; the manifest type field itself is kept
  deprecated-in-place (not removed) specifically to avoid an unplanned MAJOR
  `EXTENSION_API_VERSION` bump for a field no manifest currently declares.
  - Notified: 2026-08-29, this CHANGELOG entry, all `extension-api` consumers
  - earliest-removal: 2026-11-29 (90-day minimum notice window, matching this package's own
    established deprecation precedent)
  - notice-window-ends: 2026-11-29

## 3.9.0 — 2026-08-29

contract-hash: sha256:8ac794facfb1229f7ca08f722537e533c3a1693c813050ea6d12e977bf76d69c

### Added

- Added `ExtensionManifest.navItems?: ExtensionNavItem[]` (Story 29.3 AC1), an optional
  declaration of navigation entries (`id`/`label`/`href`/optional `icon`/optional `parentId`, one
  level of submenu nesting) that PV's own primary nav merges in as new top-level entries alongside
  the existing hardcoded items. Deliberately NOT gated behind `'ui-panel'` in `capabilities[]`,
  unlike every other optional manifest array field to date — a nav entry is a general-purpose
  capability, not intrinsically tied to the UI-panel rendering mechanism. Validated at
  `registerExtension()` time: `id` uniqueness/charset, `href` same-origin-relative-path charset
  (defense-in-depth — it renders as a live, unsanitized `<a href>`, unlike sanitized panel HTML),
  a closed `icon` token set, and `parentId` resolution (rejecting an unresolvable reference or a
  grandchild-nesting attempt) — all load-time-fail, not request-time-fail. Omitted (or
  `undefined`) is fully backward-compatible: no nav entries are added.
- Added `NAV_ITEM_ID_PATTERN`, `NAV_ITEM_HREF_PATTERN`, `MAX_NAV_ITEMS`,
  `MAX_NAV_ITEM_LABEL_LENGTH`, and `NAV_ITEM_ICON_TOKENS` (Story 29.3 AC2/AC5/AC6), the shape/
  charset/cap constants validating `navItems` entries.

## 3.8.0 — 2026-08-27

contract-hash: sha256:7e79ffc8b1bd3df87b42a5823869c66be576da8d1ebf57f50f1c868b27b0c0e5

### Added

- Added `ExtensionManifest.panelDataPaths?: string[]` (Story 25.12 AC2), an optional
  declaration of the PV-native REST path templates the DATA relay (`+page.svelte`'s
  `PANEL_DATA_REQUEST_SOURCE` handler) will forward on this extension's behalf. Omitted (or
  `undefined`) is fully backward-compatible: the host falls back to the exact pre-existing
  hardcoded pair (`DEFAULT_PANEL_DATA_PATHS`, `apps/api/src/lib/extension-panel.ts`) —
  `/api/v1/projects` and `/api/v1/projects/:id` — with a one-time warn log, mirroring
  `uiPanelSlots`'s own fallback discipline. Only legal alongside `'ui-panel'` in
  `capabilities[]`, with no `hooksFactory()`-callability cross-check (it gates a client-relay
  allowlist, not a hook's existence).
- Added `PANEL_DATA_PATH_PATTERN` (Story 25.12 AC2), the regex validating each `panelDataPaths`
  entry as a path TEMPLATE (not a bare name): the literal prefix `/api/v1/` followed by one or
  more `/`-separated segments, each either a literal `[a-z0-9-]+` token or a `:param`
  placeholder, closing the same path-traversal/route-confusion angle `UI_PANEL_SLOT_NAME_PATTERN`
  already closes for slot names.
- Added `MAX_PANEL_DATA_PATHS` (Story 25.12 AC2), bounding a manifest's `panelDataPaths` list to
  32 entries, matching `MAX_UI_PANEL_SLOTS`/`MAX_MODULE_ACTIONS`'s precedent.

## 3.7.0 — 2026-08-26

contract-hash: sha256:e12c8c32651f6ed4d9a812061449779d200575bf1a1863b681d4db33324a69cf

### Added

- Added `HostServices.ephemeralState: EphemeralStateHost` (Story 20.8 AC-1), the delivery of the
  "Ephemeral Extension State Store & Cleanup Hook Contract" decision approved in `architecture.md`
  by Story 20-7. `EphemeralStateHost` exposes `get`/`set`/`delete`/`compareAndSwap` plus a new
  `compareAndDelete(key, expectedValue): Promise<boolean>` (Story 20.8 AC-2 — resolves 20-7 AC-3's
  explicitly deferred gap: an atomic, race-free conditional discard). Backed by a dedicated,
  RLS-isolated, TTL-bounded (`(0, 3600]` seconds) Postgres table, encrypted at rest, with a
  per-org cap of 1,000 live entries and a 5-minute cleanup sweep. Bound once at extension-load
  time (like `auditEventSource`/`orgAuthorization`); its methods resolve `orgId` ambiently per
  call via the host's request-scoped context. An existing extension whose `hooksFactory`
  destructures only `{ auditEventSource }` or `{ auditEventSource, orgAuthorization }` continues
  to work unmodified.

## 3.6.0 — 2026-08-26

contract-hash: sha256:e51cc51d0b3183cf8efe1298e345973b11ef6af3a74338d80b808033539d87b1

### Changed

- No public type/schema change. `apps/api/src/extensions/loader.ts` is one of this contract's
  listed `CONTRACT_FILES` (its load/`load_failed` behaviour is observable to extensions), and
  Story 25.9 added a new, purely host-side capability to it — reading the loaded module pack's own
  `package.json` `version` field and surfacing it via the admin-only `GET /extensions/status`
  response — so `scripts/check-extension-api-version-skew.ts`'s forward-only-versioning invariant
  requires this version bump even though no exported type or hook signature changed. The bump only
  updates the `EXTENSION_API_VERSION` literal itself in the surface snapshot.

## 3.5.0 — 2026-08-26

contract-hash: sha256:3f6861634bb70045af8440c262ed2028c096b2c734428348a6fd39ebb921cb17

### Added

- Widened `UIPanelContext` with an optional `subpath?` field (Story 25.8 AC1), carrying the
  deep-linkable URL sub-path `apps/web`'s new `extensions/panels/[slot]/[...subpath]` route
  matched for the current request, so a panel can render its own internal sub-state on load.
  This field is purely routing state owned by `apps/web` — the host performs no lookup or
  authorization on its contents (same posture as `resourceId`) and it is never concatenated into
  the `GET /api/v1/extensions/panels/:slot` route's own `:slot` path parameter. Omitted (never
  `''`) when the matched URL has no sub-path.

## 3.4.0 — 2026-08-24

contract-hash: sha256:fd52653a519aba96b2338f552edd89758f78473cde1e5422714f3245f81dde4b

### Added

- Added the optional `ExtensionManifest.moduleActions?: string[]` field (Story 25.5 AC2), mirroring
  `uiPanelSlots`' exact validation shape (non-empty array of unique strings, `MODULE_ACTION_NAME_PATTERN`
  charset, capped at `MAX_MODULE_ACTIONS` entries) but in a separate, differently-named namespace —
  action names and slot names must never be conflated even though their validation shape is
  identical. Omitting `moduleActions` remains fully backward-compatible: the host serves zero
  declared actions and every action request 404s.
- Added the `ExtensionHooks.moduleAction?: ModuleAction` hook (Story 25.5 AC2/AC3), the `ModuleAction`,
  `ModuleActionContext`, `ModuleActionRequest`, and `ActionResult` types, and the new
  `POST /extensions/panels/:slot/actions` host route that re-derives identity/org/project context
  fresh per request (never trusting the request body) before invoking `onAction()`.
- Widened `UIPanelContext` with an optional `actionEndpoint?` field (Story 25.5) pointing panel
  authors at the new action route when their extension declares `moduleActions`. Omitted when the
  extension declares no `moduleActions`, so an existing extension reading only the pre-existing
  fields keeps working unmodified.

Note: Story 25.5 was developed in parallel with Story 25.4 and originally targeted `3.3.0` for this
same additive change. Story 25.4 merged to `main` first and claimed `3.3.0` for its own, different
additive change (see below). Per the forward-only-versioning invariant enforced by
`scripts/check-extension-api-version-skew.ts` (versions are allocated at merge, not at planning —
Story 23.6), this merge moves to the next free version, `3.4.0`, instead of reusing `3.3.0`.

## 3.3.0 — 2026-08-24

contract-hash: sha256:0eb56255831e227226d81f1f7967617dda8420105f759022cc724aac1ba8562a

### Added

- Added `EXTENSION_THEME_CSS_VARS` (the ordered `--pv-ext-*` property list) and the
  `ExtensionThemeCssVar` type (Story 25.4 AC4). This is PV's small, versioned "extension theming
  contract": `--pv-ext-surface`, `--pv-ext-ink`, `--pv-ext-muted`, `--pv-ext-brand`,
  `--pv-ext-line`. The host (`apps/web`'s panel-document composition function) injects a
  `:root { ... }` block declaring these, resolved from the requesting user's actually-applied PV
  theme, into every composed panel document. An extension opts in purely via CSS
  `var(--pv-ext-ink, #yourFallback)` with its own hardcoded fallback — no existing export changes
  shape, and no extension is required to consume this to keep working.
- Documented panel-authoring accessibility expectations directly on `UIPanel`'s `onRenderPanel()`
  doc comment (Story 25.4 AC5): return semantic HTML (headings, labelled form controls, `aria-live`
  status regions), and avoid a competing page-level heading role since the host already gives the
  panel's iframe a slot-derived, host-controlled `title`. Guidance only — not a new/changed type.

Note: Story 25.4 was developed in parallel with Story 25.3 and originally targeted `3.2.0` for
this same additive change. Story 25.3 merged to `main` first and claimed `3.2.0` for its own,
different additive change (see below). Per the forward-only-versioning invariant enforced by
`scripts/check-extension-api-version-skew.ts` (versions are allocated at merge, not at planning —
Story 23.6), this merge moves to the next free version, `3.3.0`, instead of reusing `3.2.0`.

## 3.2.0 — 2026-08-23

contract-hash: sha256:99e2090007f20b7cbb6b4d8e4a0a27d32404598c8d71d6eaa36394e2761132b6

### Added

- Widened `UIPanelContext` (Story 25.3) from `{ slot }` to `{ slot, resourceId?, identity: {
userId, orgRole }, orgId, projectId?, locale, theme: { name } }`. All new fields are
  server-resolved fresh per request by the host, never client-supplied. `resourceId` and
  `projectId` are both optional — omitting the corresponding query parameter leaves them
  `undefined`, so an existing extension reading only `context.slot` keeps working unmodified.
  `identity`/`orgId`/`locale`/`theme` are required (a request that reaches `onRenderPanel()`
  always has them resolved), which is backward-compatible for existing method-shorthand
  `onRenderPanel(context) {...}` implementations via TypeScript's bivariant parameter checking
  for object literals (see this story's Dev Notes Pre-mortem Analysis) — no coordinated
  consumer-side type change is required to keep compiling. `identity` deliberately carries only
  `userId`/`orgRole` — never `sessionId`/`jti`/`sessionVersion`/`isPlatformOperator`.

## 3.1.0 — 2026-08-23

contract-hash: sha256:26d77ba7639f55b02ad97a635fd29943d3f77e884bcd68e5741985e94f3efd55

### Added

- Added the optional `ExtensionManifest.uiPanelSlots?: string[]` field (Story 25.2) so an
  extension can declare the named panel slots it owns (e.g. `'group'`, `'document'`), validated
  at `registerExtension()` time against the new `UI_PANEL_SLOT_NAME_PATTERN` and
  `MAX_UI_PANEL_SLOTS` exports. Omitting `uiPanelSlots` remains fully backward-compatible: the
  host falls back to the pre-existing single implicit `'group'` slot behavior, so no existing
  extension is required to change.

## 3.0.0 — 2026-08-23

contract-hash: sha256:7d5ca8c29a7fb4d21f40a2328a51cc22d478f8e9f76d6fe1e2ae712523c241aa

### Breaking

- Removed `organizationId` from `OrgAuthorizationCheckContext` (Story 23.11). The org
  `checkMembership()` checks against is now always the host's own ambient per-request context
  (the org/identity actually driving the request that triggered the extension's call) — never a
  caller-supplied value. This closes a cross-tenant membership-enumeration risk found during
  Story 23.9's code review: a bug or compromise in the single loaded (trusted) extension could
  previously ask "is identity X a member of org Y" for an arbitrary org Y it had no legitimate
  involvement in. `viewerIdentityId` is unchanged and remains an explicit, caller-supplied
  parameter. This is a genuine TypeScript-breaking change for an existing caller that passes an
  inline object literal (e.g. `centralizeme-sass`'s `createHostBackedPvAuthorizationChecker`) —
  TypeScript's excess-property check on object-literal call arguments rejects the now-unknown
  `organizationId` field at compile time, even though the change is JS-runtime-harmless. That
  call site must drop `organizationId` from its call in a coordinated follow-up on that repo's
  side.

## 2.2.0 — 2026-08-22

contract-hash: sha256:31b84105593fc83a384d472a620eb7883622e7d86d24412497ded0480b42f82a

### Added

- Added the host-called `orgAuthorization.checkMembership()` service on `HostServices` (Story
  23.9) so extensions can ask PV whether an identity currently holds at least a given role in an
  org, without receiving database access or implementing authorization logic themselves.

## 2.1.0 — 2026-08-19

contract-hash: sha256:bc6d08f603fe27347788f45495c2d332486110eefab11ee5c5c76ba1dace640d

contract-hash: sha256:c2cce524e9651c7e49eb154d85b2088b203cf7c6fbe7b82eb76222253fdb6b8c

### Added

- Added the host-called `project-lifecycle` policy hook so extensions can participate in PV's
  transaction-scoped project-create decision without receiving database access, tier internals,
  or client-controlled tenant context.

## 2.0.0 — 2026-08-19

contract-hash: sha256:e25c0ba61d4c34fca86cc8ec965780cede2e6d33a28d26e427f89b72ecc81ff1

### Breaking

- Added the typed `dbScope` manifest request and `ExtensionRuntimeContext.getDbHandle()` runtime
  boundary for explicitly approved, least-privilege extension database access.
- The public extension API version is now `2.0.0`; extensions must rebuild against this major.
- Added `invalid-db-scope` to the registration error reason union.

## 1.4.0 — 2026-08-18

contract-hash: sha256:0a913707d61153f7e63a88df582f92ed648066fe3af55e340273927055b552bf

### Changed

- Recorded the current public API and contract-behaviour snapshots as the Story 23.6 baseline.

## 1.1.0 — 2026-08-14

### Breaking manifest and gate correction — `[pre-publication-exception]`

This release reverses the load-time compatibility check before the package's first publication.
The policy's pre-publication clause says:

> Changes to the load-time compatibility mechanism made **before the package's first publication** (i.e. before Story 23.1 lands) may ship as a **minor** despite being breaking under AC-4(a), because no out-of-repo party exists to break. **This clause expires automatically at first publication and may never be re-invoked.** Every use of it must be recorded in the CHANGELOG with the marker `[pre-publication-exception]` and the date.

The package remains private, and the known consuming repository has no extension-api dependency or
manifest declaration as of 2026-08-14. This one-time clause covers removal of the public
`isApiVersionCompatible(coreVersion, manifestApiVersionRange)` export as part of the same load-time
compatibility-mechanism change; it is expended by this release and cannot be reused after 23.1
publishes the package.

Extensions now declare the exact canonical version they were built against, and the host owns the
accepted range:

```ts
// before
apiVersion: '^1.0.0'

// after
apiVersion: '1.0.0'
```

The old predicate is replaced by
`isExtensionApiVersionSupported(declaredApiVersion)`. Reversing the direction closes wildcard and
range opt-outs instead of letting an extension author supply the predicate.

An extension that loaded yesterday can stop loading today after either a host upgrade or rollback.
The signal is the `EXTENSION_LOAD_FAILED` operational event and `load_failed` health field; the
remediation is a one-token manifest edit and rebuild against a supported host version. For an
incident rollback, `VAULT_EXTENSIONS_ALLOW_API_VERSION_ABOVE_HOST=true` is an operator-only,
temporary escape for a canonical same-major version above the host. It relaxes only the ceiling,
warns on every boot, and should be followed by rolling the extension back to match. Leaving it on
steady-state can run code against APIs the host does not have and fail as an in-process runtime
`TypeError`.

The declaration remains an unverified claim and the in-process extension is not an isolation
boundary. The range bypass is closed, but provenance is still required to prove that the code was
built against the declared version. The manifest name remains an unbounded echoed input and is
deliberately outside this change. See the load-time-gate section of the versioning policy owned by
Story 23.6 for the residual-risk list and rejected alternatives.

## 1.0.0 — baseline

### Added

- Initial public extension API contract baseline for versioning and deprecation review.
