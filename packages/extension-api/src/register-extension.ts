import semver from 'semver'
import { ExtensionRegistrationError } from './errors.js'
import { EXTENSION_API_VERSION, HOST_SUPPORTED_EXTENSION_API_RANGE } from './manifest.js'
import type { ExtensionManifest } from './manifest.js'
import type { AuthStrategy } from './hooks/auth-strategy.js'
import type { NotificationChannel } from './hooks/notification-channel.js'
import type { UIPanel } from './hooks/ui-panel.js'

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
 */
export type ExtensionHooks = {
  authStrategy?: AuthStrategy
  notificationChannel?: NotificationChannel
  uiPanel?: UIPanel
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

type RegisterExtensionOptions = {
  allowApiVersionAboveHost?: boolean
}

function isAboveHostButSameMajor(declaredApiVersion: string): boolean {
  return (
    semver.major(declaredApiVersion) === semver.major(EXTENSION_API_VERSION) &&
    semver.gt(declaredApiVersion, EXTENSION_API_VERSION)
  )
}

/**
 * AC4/AC5/AC6 — validates `manifest.name` (reverse-DNS style) and semver-based capability
 * negotiation, in that order, BEFORE ever invoking `hooksFactory`. Throws a typed
 * `ExtensionRegistrationError` synchronously on either failure, discriminated by `reason`.
 * `hooksFactory` is lazy by construction: this function never references it until both gates
 * have already passed.
 */
export function registerExtension(
  manifest: ExtensionManifest,
  hooksFactory: () => ExtensionHooks,
  options: RegisterExtensionOptions = {}
): { manifest: ExtensionManifest; hooks: ExtensionHooks } {
  if (!REVERSE_DNS_NAME_PATTERN.test(manifest.name)) {
    throw new ExtensionRegistrationError(
      'invalid-name',
      `Extension manifest name "${manifest.name}" is not reverse-DNS style (expected e.g. "com.acme.sso-extension")`
    )
  }

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

  const hooks = hooksFactory()
  return {
    manifest: {
      name: manifest.name,
      apiVersion: declaredApiVersion,
      capabilities: manifest.capabilities,
    },
    hooks,
  }
}
