import semver from 'semver'
import { ExtensionRegistrationError } from './errors.js'
import {
  EXTENSION_API_VERSION,
  HOST_SUPPORTED_EXTENSION_API_RANGE,
  MAX_MODULE_ACTIONS,
  MAX_MODULE_DATA_ROUTES,
  MAX_NAV_ITEM_LABEL_LENGTH,
  MAX_NAV_ITEMS,
  MAX_PANEL_DATA_PATHS,
  MAX_UI_PANEL_SLOTS,
  MODULE_ACTION_NAME_PATTERN,
  MODULE_DATA_ROUTE_PATH_PATTERN,
  NAV_ITEM_HREF_PATTERN,
  NAV_ITEM_ID_PATTERN,
  NAV_ITEM_ICON_TOKENS,
  PANEL_DATA_PATH_PATTERN,
  UI_PANEL_SLOT_NAME_PATTERN,
} from './manifest.js'
import type { ExtensionManifest, ModuleDataRouteDeclaration } from './manifest.js'
import type { AuthStrategy } from './hooks/auth-strategy.js'
import type { NotificationChannel } from './hooks/notification-channel.js'
import type { UIPanel } from './hooks/ui-panel.js'
import type { ModuleAction } from './hooks/module-action.js'
import type { CapabilityGate } from './hooks/capability-gate.js'
import type { DeliveryProvider } from './hooks/delivery-provider.js'
import type { HostServices } from './host-services.js'
import type { ExtensionDbScopeEntry, ExtensionRuntimeContext } from './db-access.js'
import type { ProjectCreatePolicy } from './hooks/project-lifecycle.js'
import type { ModuleDataRouteHandler } from './hooks/module-data.js'

/**
 * AC6 — reverse-DNS-style manifest name, e.g. "com.acme.sso-extension". The two quantified
 * groups match disjoint character sets (literal `.` vs `[a-z0-9-]`), so there is no ambiguous
 * overlap for catastrophic backtracking; input is also bounded by ordinary manifest-name
 * lengths, not attacker-controlled arbitrary-length strings.
 */
// eslint-disable-next-line security/detect-unsafe-regex -- see rationale in the comment above
const REVERSE_DNS_NAME_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+)+$/

/**
 * The bag of hooks an extension provides, keyed by capability. All optional — an extension only
 * implements the hooks matching the capabilities it declared in its manifest.
 *
 * Story 23.8 Dev Notes § Why `HostServices` is a new concept, not a fifth `ExtensionHooks` field:
 * `audit-event-source` is deliberately NOT a field here. Every field below is something the
 * extension implements and PV calls; `audit-event-source` is the reverse (PV implements it, the
 * extension calls it), so it lives in `HostServices` instead (`host-services.ts`). Do not "fix"
 * this asymmetry by adding an `auditEventSource` field here.
 */
export type ExtensionHooks = {
  authStrategy?: AuthStrategy
  notificationChannel?: NotificationChannel
  uiPanel?: UIPanel
  capabilityGate?: CapabilityGate
  projectLifecycle?: ProjectCreatePolicy
  /** Story 25.5 AC1 — dispatch target for `POST /extensions/panels/:slot/actions`. Only legal
   * (checked by `hasCallableModuleActionHook()`) when the manifest declares `moduleActions`. */
  moduleAction?: ModuleAction
  /**
   * Story 29.4 AC3 — keyed by the exact `"GET <path>"` string of each `moduleDataRoutes`-declared
   * route, whose values are the real per-route handler functions mounted on PV's own Fastify API
   * router. Cross-checked against `moduleDataRoutes` at `registerExtension()` time (checked by
   * `hasCallableModuleDataHooks()`) — every declared route must have exactly one matching
   * handler.
   */
  moduleData?: Record<string, ModuleDataRouteHandler>
  /**
   * Story 20.11 AC1 — a map of `notification_queue.channel` name (e.g. `"email"`) to the
   * `DeliveryProvider` handling that channel. PV's dispatcher calls the registered provider's
   * `send()` instead of the built-in nodemailer transport only for a channel present as a key
   * here (AC1/AC8). Registering the SAME channel key more than once in the same process is a
   * loud, named conflict error at wiring time (`DeliveryProviderConflictError`,
   * `apps/api/src/lib/delivery-provider.ts`) — last-registered-wins is not acceptable.
   */
  deliveryProvider?: Record<string, DeliveryProvider>
}

/** Default `HostServices` used when a caller (typically a test) invokes `registerExtension()`
 * without a real host — `writeAuditEvent()` rejects synchronously-caused-async if ever called,
 * since no real extension should be able to reach it without a genuine host wiring it up. */
const DEFAULT_HOST_SERVICES: HostServices = {
  auditEventSource: {
    writeAuditEvent: () =>
      Promise.reject(
        new Error(
          'registerExtension() was called without a real HostServices — auditEventSource.writeAuditEvent is unavailable'
        )
      ),
  },
  orgAuthorization: {
    checkMembership: () =>
      Promise.reject(
        new Error(
          'registerExtension() was called without a real HostServices — orgAuthorization.checkMembership is unavailable'
        )
      ),
  },
  ephemeralState: {
    set: () =>
      Promise.reject(
        new Error(
          'registerExtension() was called without a real HostServices — ephemeralState.set is unavailable'
        )
      ),
    get: () =>
      Promise.reject(
        new Error(
          'registerExtension() was called without a real HostServices — ephemeralState.get is unavailable'
        )
      ),
    delete: () =>
      Promise.reject(
        new Error(
          'registerExtension() was called without a real HostServices — ephemeralState.delete is unavailable'
        )
      ),
    compareAndSwap: () =>
      Promise.reject(
        new Error(
          'registerExtension() was called without a real HostServices — ephemeralState.compareAndSwap is unavailable'
        )
      ),
    compareAndDelete: () =>
      Promise.reject(
        new Error(
          'registerExtension() was called without a real HostServices — ephemeralState.compareAndDelete is unavailable'
        )
      ),
  },
}

/**
 * Host-side predicate: the extension declares a concrete version and the host owns the range.
 * Reverting to `satisfies(hostVersion, extensionRange)` is a security regression, not a
 * stylistic preference. See docs/extension-api-versioning-policy.md § Load-time gate.
 */
export function isExtensionApiVersionSupported(declaredApiVersion: string): boolean {
  return semver.satisfies(declaredApiVersion, HOST_SUPPORTED_EXTENSION_API_RANGE, {
    includePrerelease: false,
  })
}

type RegisterExtensionLogger = { warn: (message: string) => void }

type RegisterExtensionOptions = {
  allowApiVersionAboveHost?: boolean
  /** Story 23.2 AC-2 (finding N17) — unrecognized top-level manifest keys are warned, not thrown. */
  logger?: RegisterExtensionLogger
}

const noopLogger: RegisterExtensionLogger = { warn: () => undefined }

/** Story 23.2 AC-2 — the complete, fixed set of top-level `ExtensionManifest` keys. */
const KNOWN_MANIFEST_KEYS = [
  'name',
  'apiVersion',
  'capabilities',
  'replacesNativeLogin',
  'dbScope',
  'uiPanelSlots',
  'moduleActions',
  'panelDataPaths',
  'navItems',
  'moduleDataRoutes',
]

const INVALID_MANIFEST_FIELD = 'invalid-manifest-field'

const DEFAULT_RUNTIME_HOST: ExtensionRuntimeContext & HostServices = {
  ...DEFAULT_HOST_SERVICES,
  getDbHandle: async () => ({ unavailable: 'not-configured' }),
}

/**
 * Story 23.2 AC-2 (finding N17) — logs every unrecognized top-level manifest key at `warn`
 * (keys only, never values), and returns `true` iff an unrecognized key is an exact
 * case-insensitive match of a known field name but not an exact case-sensitive match — the one
 * deterministic case that fails the load. The edit-distance heuristic the first draft specified
 * is deliberately not implemented (see AC-2's Dev Notes rationale).
 */
function checkUnknownManifestKeys(
  manifest: ExtensionManifest,
  logger: RegisterExtensionLogger
): boolean {
  let hasCaseFoldNearMiss = false
  for (const key of Object.keys(manifest)) {
    if (KNOWN_MANIFEST_KEYS.includes(key)) continue
    const caseInsensitiveMatch = KNOWN_MANIFEST_KEYS.some(
      (known) => known.toLowerCase() === key.toLowerCase()
    )
    if (caseInsensitiveMatch) {
      hasCaseFoldNearMiss = true
    }
    logger.warn(`Extension manifest declares unrecognized key "${key}"`)
  }
  return hasCaseFoldNearMiss
}

/**
 * Story 23.2 AC-2 — validates the optional `replacesNativeLogin` field's shape and, when `true`,
 * that `'auth-provider'` is declared in `capabilities[]`. Does NOT check for the `authStrategy`
 * hook — that check needs `hooksFactory()`'s result and runs later, after `hooksFactory()` is
 * invoked (register-extension.ts's existing lazy-hooksFactory convention).
 */
function validateReplacesNativeLoginShape(manifest: ExtensionManifest): void {
  if (manifest.replacesNativeLogin === undefined) return
  if (typeof manifest.replacesNativeLogin !== 'boolean') {
    throw new ExtensionRegistrationError(
      INVALID_MANIFEST_FIELD,
      `Extension manifest field "replacesNativeLogin" must be a boolean, got ${JSON.stringify(manifest.replacesNativeLogin)}`
    )
  }
  if (manifest.replacesNativeLogin && !manifest.capabilities.includes('auth-provider')) {
    throw new ExtensionRegistrationError(
      INVALID_MANIFEST_FIELD,
      `Extension manifest declares "replacesNativeLogin: true" but does not declare "auth-provider" in capabilities[]`
    )
  }
}

/**
 * Story 25.2 AC1 — validates the optional `uiPanelSlots` field's shape: non-empty array of
 * unique strings (if present), each matching `UI_PANEL_SLOT_NAME_PATTERN`, capped at
 * `MAX_UI_PANEL_SLOTS` entries, and only legal alongside `'ui-panel'` in `capabilities[]`.
 * Mirrors `validateReplacesNativeLoginShape`'s structure exactly. Does NOT check for the
 * `uiPanel` hook itself — that check needs `hooksFactory()`'s result and runs later, after
 * `hooksFactory()` is invoked (see `hasCallableUiPanelHook` below).
 */
function validateUiPanelSlotsShape(manifest: ExtensionManifest): void {
  if (manifest.uiPanelSlots === undefined) return

  if (!Array.isArray(manifest.uiPanelSlots)) {
    throw new ExtensionRegistrationError(
      INVALID_MANIFEST_FIELD,
      `Extension manifest field "uiPanelSlots" must be an array, got ${JSON.stringify(manifest.uiPanelSlots)}`
    )
  }

  if (manifest.uiPanelSlots.length === 0) {
    throw new ExtensionRegistrationError(
      INVALID_MANIFEST_FIELD,
      'Extension manifest field "uiPanelSlots" must not be an empty array — omit the field entirely to declare no slots'
    )
  }

  if (manifest.uiPanelSlots.length > MAX_UI_PANEL_SLOTS) {
    throw new ExtensionRegistrationError(
      INVALID_MANIFEST_FIELD,
      `Extension manifest field "uiPanelSlots" declares ${manifest.uiPanelSlots.length} entries, exceeding the maximum of ${MAX_UI_PANEL_SLOTS}`
    )
  }

  const seen = new Set<string>()
  for (const slot of manifest.uiPanelSlots) {
    if (typeof slot !== 'string' || !UI_PANEL_SLOT_NAME_PATTERN.test(slot)) {
      throw new ExtensionRegistrationError(
        INVALID_MANIFEST_FIELD,
        `Extension manifest field "uiPanelSlots" contains an invalid slot name ${JSON.stringify(slot)} (expected to match ${UI_PANEL_SLOT_NAME_PATTERN})`
      )
    }
    if (seen.has(slot)) {
      throw new ExtensionRegistrationError(
        INVALID_MANIFEST_FIELD,
        `Extension manifest field "uiPanelSlots" contains duplicate slot name "${slot}"`
      )
    }
    seen.add(slot)
  }

  if (!manifest.capabilities.includes('ui-panel')) {
    throw new ExtensionRegistrationError(
      INVALID_MANIFEST_FIELD,
      'Extension manifest declares "uiPanelSlots" but does not declare "ui-panel" in capabilities[]'
    )
  }
}

/**
 * Story 25.5 AC2 — validates the optional `moduleActions` field's shape: non-empty array of
 * unique strings (if present), each matching `MODULE_ACTION_NAME_PATTERN`, capped at
 * `MAX_MODULE_ACTIONS` entries, and only legal alongside `'ui-panel'` in `capabilities[]`.
 * Mirrors `validateUiPanelSlotsShape` exactly (separate constants, identical shape — action names
 * and slot names are different namespaces). Does NOT check for the `moduleAction` hook itself —
 * that check needs `hooksFactory()`'s result and runs later (see `hasCallableModuleActionHook`
 * below).
 */
function validateModuleActionsShape(manifest: ExtensionManifest): void {
  if (manifest.moduleActions === undefined) return

  if (!Array.isArray(manifest.moduleActions)) {
    throw new ExtensionRegistrationError(
      INVALID_MANIFEST_FIELD,
      `Extension manifest field "moduleActions" must be an array, got ${JSON.stringify(manifest.moduleActions)}`
    )
  }

  if (manifest.moduleActions.length === 0) {
    throw new ExtensionRegistrationError(
      INVALID_MANIFEST_FIELD,
      'Extension manifest field "moduleActions" must not be an empty array — omit the field entirely to declare no actions'
    )
  }

  if (manifest.moduleActions.length > MAX_MODULE_ACTIONS) {
    throw new ExtensionRegistrationError(
      INVALID_MANIFEST_FIELD,
      `Extension manifest field "moduleActions" declares ${manifest.moduleActions.length} entries, exceeding the maximum of ${MAX_MODULE_ACTIONS}`
    )
  }

  const seen = new Set<string>()
  for (const action of manifest.moduleActions) {
    if (typeof action !== 'string' || !MODULE_ACTION_NAME_PATTERN.test(action)) {
      throw new ExtensionRegistrationError(
        INVALID_MANIFEST_FIELD,
        `Extension manifest field "moduleActions" contains an invalid action name ${JSON.stringify(action)} (expected to match ${MODULE_ACTION_NAME_PATTERN})`
      )
    }
    if (seen.has(action)) {
      throw new ExtensionRegistrationError(
        INVALID_MANIFEST_FIELD,
        `Extension manifest field "moduleActions" contains duplicate action name "${action}"`
      )
    }
    seen.add(action)
  }

  if (!manifest.capabilities.includes('ui-panel')) {
    throw new ExtensionRegistrationError(
      INVALID_MANIFEST_FIELD,
      'Extension manifest declares "moduleActions" but does not declare "ui-panel" in capabilities[]'
    )
  }
}

/**
 * Story 25.12 AC2 — validates the optional `panelDataPaths` field's shape: non-empty array of
 * unique strings (if present), each matching `PANEL_DATA_PATH_PATTERN` (a full path template
 * starting with `/api/v1/`), capped at `MAX_PANEL_DATA_PATHS` entries, and only legal alongside
 * `'ui-panel'` in `capabilities[]`. Mirrors `validateUiPanelSlotsShape`/`validateModuleActionsShape`
 * structurally. Unlike those two, this field has NO corresponding post-`hooksFactory()`
 * callability check (AC3) — it gates a client-relay allowlist, not a hook's existence, so there
 * is nothing analogous to `hasCallableUiPanelHook`/`hasCallableModuleActionHook` to add.
 */
function validatePanelDataPathsShape(manifest: ExtensionManifest): void {
  // Read the deprecated field exactly once here (kept deprecated-in-place per Story 29.4) so the
  // rest of this validator narrows/reuses a plain local instead of repeatedly re-flagging a
  // deprecated property access.
  const panelDataPaths = manifest.panelDataPaths // NOSONAR(typescript:S1874)
  if (panelDataPaths === undefined) return

  if (!Array.isArray(panelDataPaths)) {
    throw new ExtensionRegistrationError(
      INVALID_MANIFEST_FIELD,
      `Extension manifest field "panelDataPaths" must be an array, got ${JSON.stringify(panelDataPaths)}`
    )
  }

  if (panelDataPaths.length === 0) {
    throw new ExtensionRegistrationError(
      INVALID_MANIFEST_FIELD,
      'Extension manifest field "panelDataPaths" must not be an empty array — omit the field entirely to declare no additional data paths'
    )
  }

  if (panelDataPaths.length > MAX_PANEL_DATA_PATHS) {
    throw new ExtensionRegistrationError(
      INVALID_MANIFEST_FIELD,
      `Extension manifest field "panelDataPaths" declares ${panelDataPaths.length} entries, exceeding the maximum of ${MAX_PANEL_DATA_PATHS}`
    )
  }

  const seen = new Set<string>()
  for (const path of panelDataPaths) {
    if (typeof path !== 'string' || !PANEL_DATA_PATH_PATTERN.test(path)) {
      throw new ExtensionRegistrationError(
        INVALID_MANIFEST_FIELD,
        `Extension manifest field "panelDataPaths" contains an invalid path template ${JSON.stringify(path)} (expected to match ${PANEL_DATA_PATH_PATTERN})`
      )
    }
    if (seen.has(path)) {
      throw new ExtensionRegistrationError(
        INVALID_MANIFEST_FIELD,
        `Extension manifest field "panelDataPaths" contains duplicate path template "${path}"`
      )
    }
    seen.add(path)
  }

  if (!manifest.capabilities.includes('ui-panel')) {
    throw new ExtensionRegistrationError(
      INVALID_MANIFEST_FIELD,
      'Extension manifest declares "panelDataPaths" but does not declare "ui-panel" in capabilities[]'
    )
  }
}

/**
 * Story 29.4 AC1 — validates the optional `moduleDataRoutes` field's shape: non-empty array (if
 * present) of `{ method: 'GET'; path: string }` entries, each `path` matching
 * `MODULE_DATA_ROUTE_PATH_PATTERN`, each `(method, path)` pair unique within the array, capped at
 * `MAX_MODULE_DATA_ROUTES` entries. Deliberately NOT gated behind the `'ui-panel'` capability
 * (mirrors `navItems`' own intentional divergence — a module-data route is a general-purpose
 * REST endpoint, not specifically a UI-panel-rendering concern). Does NOT check for the
 * `moduleData` hooks map itself — that check needs `hooksFactory()`'s result and runs later (see
 * `hasCallableModuleDataHooks` below).
 */
/**
 * Story 29.4 AC1 — validates one `moduleDataRoutes` entry's own shape (method/path charset) and
 * tracks `(method, path)` uniqueness across the array, as a side effect adding this entry's key
 * to `seen`. Extracted from `validateModuleDataRoutesShape()` purely to keep that function's
 * cyclomatic complexity within this repo's lint budget, mirroring
 * `validateNavItemIdAndTrackDuplicates`'s own identical extraction precedent.
 */
function validateSingleModuleDataRoute(route: unknown, seen: Set<string>): void {
  const candidate = route as ModuleDataRouteDeclaration
  const isValidShape =
    !!route &&
    typeof route === 'object' &&
    candidate.method === 'GET' &&
    typeof candidate.path === 'string' &&
    MODULE_DATA_ROUTE_PATH_PATTERN.test(candidate.path)

  if (!isValidShape) {
    throw new ExtensionRegistrationError(
      INVALID_MANIFEST_FIELD,
      `Extension manifest field "moduleDataRoutes" contains an invalid entry ${JSON.stringify(route)} (expected { method: 'GET', path } where path matches ${MODULE_DATA_ROUTE_PATH_PATTERN})`
    )
  }

  const key = `${candidate.method} ${candidate.path}`
  if (seen.has(key)) {
    throw new ExtensionRegistrationError(
      INVALID_MANIFEST_FIELD,
      `Extension manifest field "moduleDataRoutes" contains duplicate route "${key}"`
    )
  }
  seen.add(key)
}

function validateModuleDataRoutesShape(manifest: ExtensionManifest): void {
  if (manifest.moduleDataRoutes === undefined) return

  if (!Array.isArray(manifest.moduleDataRoutes)) {
    throw new ExtensionRegistrationError(
      INVALID_MANIFEST_FIELD,
      `Extension manifest field "moduleDataRoutes" must be an array, got ${JSON.stringify(manifest.moduleDataRoutes)}`
    )
  }

  if (manifest.moduleDataRoutes.length === 0) {
    throw new ExtensionRegistrationError(
      INVALID_MANIFEST_FIELD,
      'Extension manifest field "moduleDataRoutes" must not be an empty array — omit the field entirely to declare no module-data routes'
    )
  }

  if (manifest.moduleDataRoutes.length > MAX_MODULE_DATA_ROUTES) {
    throw new ExtensionRegistrationError(
      INVALID_MANIFEST_FIELD,
      `Extension manifest field "moduleDataRoutes" declares ${manifest.moduleDataRoutes.length} entries, exceeding the maximum of ${MAX_MODULE_DATA_ROUTES}`
    )
  }

  const seen = new Set<string>()
  for (const route of manifest.moduleDataRoutes) {
    validateSingleModuleDataRoute(route, seen)
  }
}

const NAV_ITEM_ICON_TOKEN_SET = new Set<string>(NAV_ITEM_ICON_TOKENS)

type NavItemCandidate = {
  id: string
  label: string
  href: string
  icon?: string
  parentId?: string
}

/**
 * Story 29.3 AC2/AC4/AC5/AC6 — validates one `navItems` entry's own fields (id charset/uniqueness,
 * label shape, href shape, icon token) in isolation, adding its `id` to `seenIds` as a side effect
 * so the caller's loop can detect duplicates across entries. Extracted from
 * `validateNavItemsShape()` purely to keep that function's cyclomatic/cognitive complexity within
 * this repo's lint budget.
 */
function validateNavItemIdAndTrackDuplicates(item: NavItemCandidate, seenIds: Set<string>): void {
  if (typeof item.id !== 'string' || !NAV_ITEM_ID_PATTERN.test(item.id)) {
    throw new ExtensionRegistrationError(
      INVALID_MANIFEST_FIELD,
      `Extension manifest field "navItems" contains an invalid item id ${JSON.stringify(item.id)} (expected to match ${NAV_ITEM_ID_PATTERN})`
    )
  }
  if (seenIds.has(item.id)) {
    throw new ExtensionRegistrationError(
      INVALID_MANIFEST_FIELD,
      `Extension manifest field "navItems" contains duplicate item id "${item.id}"`
    )
  }
  seenIds.add(item.id)
}

function validateNavItemLabelAndHref(item: NavItemCandidate): void {
  if (
    typeof item.label !== 'string' ||
    item.label.length === 0 ||
    item.label.length > MAX_NAV_ITEM_LABEL_LENGTH
  ) {
    throw new ExtensionRegistrationError(
      INVALID_MANIFEST_FIELD,
      `Extension manifest field "navItems" item "${item.id}" has an invalid label (must be a non-empty string of at most ${MAX_NAV_ITEM_LABEL_LENGTH} characters)`
    )
  }

  if (typeof item.href !== 'string' || !NAV_ITEM_HREF_PATTERN.test(item.href)) {
    throw new ExtensionRegistrationError(
      INVALID_MANIFEST_FIELD,
      `Extension manifest field "navItems" item "${item.id}" has an invalid href ${JSON.stringify(item.href)} (expected a same-origin relative path matching ${NAV_ITEM_HREF_PATTERN})`
    )
  }
}

/**
 * Story 29.3 AC2/AC4/AC5/AC6 — validates one `navItems` entry's own fields (id charset/
 * uniqueness, label shape, href shape, icon token), delegating to
 * `validateNavItemIdAndTrackDuplicates`/`validateNavItemLabelAndHref` to keep this function's own
 * complexity within this repo's lint budget.
 */
function validateSingleNavItemFields(item: NavItemCandidate, seenIds: Set<string>): void {
  validateNavItemIdAndTrackDuplicates(item, seenIds)
  validateNavItemLabelAndHref(item)

  if (item.icon !== undefined && !NAV_ITEM_ICON_TOKEN_SET.has(item.icon)) {
    throw new ExtensionRegistrationError(
      INVALID_MANIFEST_FIELD,
      `Extension manifest field "navItems" item "${item.id}" declares an unrecognized icon token ${JSON.stringify(item.icon)}`
    )
  }
}

/**
 * Story 29.3 AC2/AC3 — validates every `parentId` resolves to another `id` present in the SAME
 * array (never itself), and that nesting stops at exactly one level (an item that is both a
 * `parentId` target AND itself carries a `parentId` is a rejected "grandchild" attempt). Extracted
 * from `validateNavItemsShape()` for the same complexity-budget reason as
 * `validateSingleNavItemFields` above.
 */
function validateNavItemParentIds(items: NavItemCandidate[], seenIds: Set<string>): void {
  const idsWithChildren = new Set<string>()
  for (const item of items) {
    if (item.parentId === undefined) continue
    if (item.parentId === item.id) {
      throw new ExtensionRegistrationError(
        INVALID_MANIFEST_FIELD,
        `Extension manifest field "navItems" item "${item.id}" declares "parentId" referencing itself`
      )
    }
    if (!seenIds.has(item.parentId)) {
      throw new ExtensionRegistrationError(
        INVALID_MANIFEST_FIELD,
        `Extension manifest field "navItems" item "${item.id}" declares "parentId" ${JSON.stringify(item.parentId)}, which does not match any item id in the same array`
      )
    }
    idsWithChildren.add(item.parentId)
  }

  // AC3: exactly one level of nesting — a child's own id may not itself be a parentId target.
  for (const item of items) {
    if (item.parentId !== undefined && idsWithChildren.has(item.id)) {
      throw new ExtensionRegistrationError(
        INVALID_MANIFEST_FIELD,
        `Extension manifest field "navItems" item "${item.id}" is both a parent and a child — only one level of nesting is allowed`
      )
    }
  }
}

/**
 * Story 29.3 AC1-AC3/AC6 — validates the optional `navItems` field's shape: non-empty array (if
 * present), capped at `MAX_NAV_ITEMS`, each entry's own fields (`validateSingleNavItemFields`),
 * and every `parentId` reference/nesting-depth rule (`validateNavItemParentIds`). Deliberately NOT
 * gated behind `'ui-panel'` in `capabilities[]` — see `manifest.ts`'s own `navItems` doc comment
 * for why this is an intentional divergence from `validateUiPanelSlotsShape`/
 * `validateModuleActionsShape`/`validatePanelDataPathsShape`'s shared capability-gate pattern.
 */
function validateNavItemsShape(manifest: ExtensionManifest): void {
  if (manifest.navItems === undefined) return

  if (!Array.isArray(manifest.navItems)) {
    throw new ExtensionRegistrationError(
      INVALID_MANIFEST_FIELD,
      `Extension manifest field "navItems" must be an array, got ${JSON.stringify(manifest.navItems)}`
    )
  }

  if (manifest.navItems.length === 0) {
    throw new ExtensionRegistrationError(
      INVALID_MANIFEST_FIELD,
      'Extension manifest field "navItems" must not be an empty array — omit the field entirely to declare no nav items'
    )
  }

  if (manifest.navItems.length > MAX_NAV_ITEMS) {
    throw new ExtensionRegistrationError(
      INVALID_MANIFEST_FIELD,
      `Extension manifest field "navItems" declares ${manifest.navItems.length} entries, exceeding the maximum of ${MAX_NAV_ITEMS}`
    )
  }

  const seenIds = new Set<string>()
  for (const item of manifest.navItems) {
    validateSingleNavItemFields(item, seenIds)
  }

  validateNavItemParentIds(manifest.navItems, seenIds)
}

const DB_SCOPE_TABLE_PATTERN = /^[a-z][a-z0-9_]*$/
const DB_SCOPE_OPERATIONS = new Set(['select', 'insert', 'update', 'delete'])
const INVALID_DB_SCOPE = 'invalid-db-scope' as const

function invalidDbScope(message: string): never {
  throw new ExtensionRegistrationError(INVALID_DB_SCOPE, message)
}

function validateDbScopeEntry(entry: unknown, tables: Set<string>): void {
  if (!entry || typeof entry !== 'object') invalidDbScope('Each dbScope entry must be an object')
  const candidate = entry as { table?: unknown; operations?: unknown }
  if (typeof candidate.table !== 'string' || !DB_SCOPE_TABLE_PATTERN.test(candidate.table)) {
    invalidDbScope('dbScope table must be an unqualified PostgreSQL identifier')
  }
  if (tables.has(candidate.table)) {
    invalidDbScope(`dbScope contains duplicate table "${candidate.table}"`)
  }
  tables.add(candidate.table)
  if (!Array.isArray(candidate.operations) || candidate.operations.length === 0) {
    invalidDbScope(`dbScope table "${candidate.table}" must declare operations`)
  }
  const operations = new Set(candidate.operations)
  if (operations.size !== candidate.operations.length) {
    invalidDbScope(`dbScope table "${candidate.table}" contains an invalid or duplicate operation`)
  }
  if ([...operations].some((operation) => !DB_SCOPE_OPERATIONS.has(String(operation)))) {
    invalidDbScope(`dbScope table "${candidate.table}" contains an invalid or duplicate operation`)
  }
}

function validateDbScopeShape(
  value: unknown
): asserts value is ExtensionDbScopeEntry[] | undefined {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    invalidDbScope('Extension manifest dbScope must be an array')
  }
  const tables = new Set<string>()
  for (const entry of value) validateDbScopeEntry(entry, tables)
}

function isAboveHostButSameMajor(declaredApiVersion: string): boolean {
  return (
    semver.major(declaredApiVersion) === semver.major(EXTENSION_API_VERSION) &&
    semver.gt(declaredApiVersion, EXTENSION_API_VERSION)
  )
}

/** AC4/AC5/AC6 — validates the declared `apiVersion` is a concrete, in-range semver version. */
function assertApiVersionSupported(
  manifest: ExtensionManifest,
  options: RegisterExtensionOptions
): string {
  const { apiVersion: declaredApiVersion } = manifest
  const truncatedApiVersion = String(declaredApiVersion).slice(0, 64)
  const isCanonicalVersion =
    typeof declaredApiVersion === 'string' &&
    declaredApiVersion.length <= 64 &&
    semver.valid(declaredApiVersion) === declaredApiVersion

  if (!isCanonicalVersion) {
    throw new ExtensionRegistrationError(
      'incompatible-version',
      `Extension manifest apiVersion "${truncatedApiVersion}" is not a concrete semver version. Declare the exact EXTENSION_API_VERSION this extension was built against (e.g. "${EXTENSION_API_VERSION}"); ranges and wildcards are no longer accepted.`
    )
  }

  const supported = isExtensionApiVersionSupported(declaredApiVersion)
  const allowedByRollbackEscape =
    options.allowApiVersionAboveHost === true &&
    !supported &&
    isAboveHostButSameMajor(declaredApiVersion)

  if (!supported && !allowedByRollbackEscape) {
    throw new ExtensionRegistrationError(
      'incompatible-version',
      `Extension manifest apiVersion "${truncatedApiVersion}" is outside this host's supported range "${HOST_SUPPORTED_EXTENSION_API_RANGE}" (host EXTENSION_API_VERSION "${EXTENSION_API_VERSION}").`
    )
  }

  return declaredApiVersion
}

function hasCallableProjectLifecycleHook(
  manifest: ExtensionManifest,
  hooks: ExtensionHooks
): boolean {
  if (!manifest.capabilities.includes('project-lifecycle')) return true
  return (
    hooks.projectLifecycle !== undefined &&
    typeof hooks.projectLifecycle.onBeforeCreateProject === 'function'
  )
}

/**
 * Story 25.2 AC1 (Boundary & Edge Case Sweep finding) — a manifest declaring `uiPanelSlots`
 * (implying real slot names exist to serve) whose `hooksFactory()` result has no `uiPanel` hook
 * at all is rejected, mirroring `hasCallableProjectLifecycleHook` exactly. General `'ui-panel'`
 * capability declared WITHOUT `uiPanelSlots` is deliberately NOT checked here — AC2's fallback
 * path depends on that exact combination staying legal.
 */
function hasCallableUiPanelHook(manifest: ExtensionManifest, hooks: ExtensionHooks): boolean {
  if (!manifest.uiPanelSlots) return true
  return hooks.uiPanel !== undefined && typeof hooks.uiPanel.onRenderPanel === 'function'
}

/**
 * Story 25.5 AC2 — a manifest declaring `moduleActions` (implying real action kinds exist to
 * dispatch) whose `hooksFactory()` result has no `moduleAction` hook at all is rejected — a
 * load-time registration error, not a silent per-request degradation. Mirrors
 * `hasCallableUiPanelHook` exactly.
 */
function hasCallableModuleActionHook(manifest: ExtensionManifest, hooks: ExtensionHooks): boolean {
  if (!manifest.moduleActions) return true
  return hooks.moduleAction !== undefined && typeof hooks.moduleAction.onAction === 'function'
}

/**
 * Story 29.4 AC3 — a manifest declaring `moduleDataRoutes` whose `hooksFactory()` result has no
 * `moduleData` map at all, or a `moduleData` map missing the exact `"GET <path>"` key for one of
 * the declared routes, is rejected — every declared route must have exactly one matching handler,
 * checked individually (returns the first missing route key found, not a boolean, so the caller
 * can build a precise error message naming it).
 */
function findMissingModuleDataRoute(
  manifest: ExtensionManifest,
  hooks: ExtensionHooks
): string | undefined {
  if (!manifest.moduleDataRoutes) return undefined
  for (const route of manifest.moduleDataRoutes) {
    const key = `${route.method} ${route.path}`
    // eslint-disable-next-line security/detect-object-injection -- key is derived from this same manifest's own moduleDataRoutes entries (already charset/shape-validated by validateModuleDataRoutesShape), never from untrusted input.
    if (typeof hooks.moduleData?.[key] !== 'function') return key
  }
  return undefined
}

/**
 * Post-`hooksFactory()` callability checks, grouped into one function purely to keep
 * `registerExtension`'s own cyclomatic complexity within this repo's lint budget — behaviorally
 * these are four independent gates, each throwing its own typed error, checked in the same order
 * they were checked inline before this extraction.
 */
function assertCallableHooksAfterFactory(manifest: ExtensionManifest, hooks: ExtensionHooks): void {
  if (!hasCallableProjectLifecycleHook(manifest, hooks)) {
    throw new ExtensionRegistrationError(
      'invalid-manifest-field',
      'Extension manifest declares "project-lifecycle" but hooksFactory() did not return a callable projectLifecycle hook'
    )
  }

  // Story 25.2 AC1 (Boundary & Edge Case Sweep finding) — a manifest promising `uiPanelSlots`
  // with nothing behind it is the same class of bug `hasCallableProjectLifecycleHook` already
  // catches above; runs after hooksFactory() per this function's existing lazy-hooksFactory
  // convention, same as the project-lifecycle check.
  if (!hasCallableUiPanelHook(manifest, hooks)) {
    throw new ExtensionRegistrationError(
      INVALID_MANIFEST_FIELD,
      'Extension manifest declares "uiPanelSlots" but hooksFactory() did not return a callable uiPanel hook'
    )
  }

  // Story 25.5 AC2 — same class of bug hasCallableUiPanelHook already catches above: a manifest
  // promising moduleActions with nothing behind it. Runs after hooksFactory() per this function's
  // existing lazy-hooksFactory convention.
  if (!hasCallableModuleActionHook(manifest, hooks)) {
    throw new ExtensionRegistrationError(
      INVALID_MANIFEST_FIELD,
      'Extension manifest declares "moduleActions" but hooksFactory() did not return a callable moduleAction hook'
    )
  }

  // Story 29.4 AC3 — same class of bug hasCallableUiPanelHook/hasCallableModuleActionHook
  // already catch above: a manifest promising moduleDataRoutes with no matching handler behind
  // one (or more) of them. Runs after hooksFactory() per this function's existing
  // lazy-hooksFactory convention.
  const missingModuleDataRoute = findMissingModuleDataRoute(manifest, hooks)
  if (missingModuleDataRoute !== undefined) {
    throw new ExtensionRegistrationError(
      INVALID_MANIFEST_FIELD,
      `Extension manifest declares "moduleDataRoutes" entry "${missingModuleDataRoute}" but hooksFactory() did not return a callable handler for it`
    )
  }

  // Story 23.2 AC-2 — a manifest declaring `replacesNativeLogin: true` whose hooksFactory()
  // yields no authStrategy would disable the only working login path with nothing to replace
  // it. Rejected here, after hooksFactory() has already been invoked per this function's
  // existing lazy-hooksFactory convention (register-extension.ts:73-74 in the pre-23.2 code) —
  // no restructuring needed, this is a post-factory assertion.
  if (manifest.replacesNativeLogin === true && typeof hooks.authStrategy !== 'object') {
    throw new ExtensionRegistrationError(
      INVALID_MANIFEST_FIELD,
      'Extension manifest declares "replacesNativeLogin: true" but hooksFactory() did not return an authStrategy hook'
    )
  }
}

/**
 * AC4/AC5/AC6 — validates `manifest.name` (reverse-DNS style) and semver-based capability
 * negotiation, in that order, BEFORE ever invoking `hooksFactory`. Throws a typed
 * `ExtensionRegistrationError` synchronously on either failure, discriminated by `reason`.
 * `hooksFactory` is lazy by construction: this function never references it until both gates
 * have already passed.
 *
 * Story 23.2 AC-2 — the `replacesNativeLogin` field and unknown-key checks run FIRST,
 * unconditionally, before the name/version gates — they must never be reachable only through a
 * version-compatible extension (an extension declaring `apiVersion: '*'` must still be rejected
 * for a bad `replacesNativeLogin` value).
 */
export function registerExtension(
  manifest: ExtensionManifest,
  hooksFactory: (context: ExtensionRuntimeContext & HostServices) => ExtensionHooks,
  options: RegisterExtensionOptions = {},
  host: ExtensionRuntimeContext & HostServices = DEFAULT_RUNTIME_HOST
): { manifest: ExtensionManifest; hooks: ExtensionHooks } {
  const logger = options.logger ?? noopLogger
  const hasCaseFoldNearMiss = checkUnknownManifestKeys(manifest, logger)
  if (hasCaseFoldNearMiss) {
    throw new ExtensionRegistrationError(
      INVALID_MANIFEST_FIELD,
      'Extension manifest declares a key that is a case-insensitive near-miss of a known field name'
    )
  }
  validateReplacesNativeLoginShape(manifest)
  validateDbScopeShape(manifest.dbScope)
  validateUiPanelSlotsShape(manifest)
  validateModuleActionsShape(manifest)
  validatePanelDataPathsShape(manifest)
  validateNavItemsShape(manifest)
  validateModuleDataRoutesShape(manifest)

  if (!REVERSE_DNS_NAME_PATTERN.test(manifest.name)) {
    throw new ExtensionRegistrationError(
      'invalid-name',
      `Extension manifest name "${manifest.name}" is not reverse-DNS style (expected e.g. "com.acme.sso-extension")`
    )
  }

  const declaredApiVersion = assertApiVersionSupported(manifest, options)

  const hooks = hooksFactory(host)

  assertCallableHooksAfterFactory(manifest, hooks)

  return {
    manifest: {
      name: manifest.name,
      apiVersion: declaredApiVersion,
      capabilities: manifest.capabilities,
      replacesNativeLogin: manifest.replacesNativeLogin,
      dbScope: manifest.dbScope,
      uiPanelSlots: manifest.uiPanelSlots,
      moduleActions: manifest.moduleActions,
      panelDataPaths: manifest.panelDataPaths, // NOSONAR(typescript:S1874) — passthrough of the deprecated-in-place field, see validatePanelDataPathsShape's own note
      navItems: manifest.navItems,
      moduleDataRoutes: manifest.moduleDataRoutes,
    },
    hooks,
  }
}
