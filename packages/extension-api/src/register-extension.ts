import semver from 'semver'
import { ExtensionRegistrationError } from './errors.js'
import {
  EXTENSION_API_VERSION,
  HOST_SUPPORTED_EXTENSION_API_RANGE,
  MAX_MODULE_ACTIONS,
  MAX_UI_PANEL_SLOTS,
  MODULE_ACTION_NAME_PATTERN,
  UI_PANEL_SLOT_NAME_PATTERN,
} from './manifest.js'
import type { ExtensionManifest } from './manifest.js'
import type { AuthStrategy } from './hooks/auth-strategy.js'
import type { NotificationChannel } from './hooks/notification-channel.js'
import type { UIPanel } from './hooks/ui-panel.js'
import type { ModuleAction } from './hooks/module-action.js'
import type { CapabilityGate } from './hooks/capability-gate.js'
import type { HostServices } from './host-services.js'
import type { ExtensionDbScopeEntry, ExtensionRuntimeContext } from './db-access.js'
import type { ProjectCreatePolicy } from './hooks/project-lifecycle.js'

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
    },
    hooks,
  }
}
