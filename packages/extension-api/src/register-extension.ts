import semver from 'semver'
import { ExtensionRegistrationError } from './errors.js'
import { EXTENSION_API_VERSION, HOST_SUPPORTED_EXTENSION_API_RANGE } from './manifest.js'
import type { ExtensionManifest } from './manifest.js'
import type { AuthStrategy } from './hooks/auth-strategy.js'
import type { NotificationChannel } from './hooks/notification-channel.js'
import type { UIPanel } from './hooks/ui-panel.js'
import type { CapabilityGate } from './hooks/capability-gate.js'
import type { HostServices } from './host-services.js'

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
const KNOWN_MANIFEST_KEYS = ['name', 'apiVersion', 'capabilities', 'replacesNativeLogin']

const INVALID_MANIFEST_FIELD = 'invalid-manifest-field'

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
  hooksFactory: (host: HostServices) => ExtensionHooks,
  options: RegisterExtensionOptions = {},
  host: HostServices = DEFAULT_HOST_SERVICES
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

  if (!REVERSE_DNS_NAME_PATTERN.test(manifest.name)) {
    throw new ExtensionRegistrationError(
      'invalid-name',
      `Extension manifest name "${manifest.name}" is not reverse-DNS style (expected e.g. "com.acme.sso-extension")`
    )
  }

  const declaredApiVersion = assertApiVersionSupported(manifest, options)

  const hooks = hooksFactory(host)

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

  return {
    manifest: {
      name: manifest.name,
      apiVersion: declaredApiVersion,
      capabilities: manifest.capabilities,
      replacesNativeLogin: manifest.replacesNativeLogin,
    },
    hooks,
  }
}
