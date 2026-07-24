import semver from 'semver'
import { ExtensionRegistrationError } from './errors.js'
import { EXTENSION_API_VERSION } from './manifest.js'
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
 * AC5 — whether `coreVersion` satisfies `manifestApiVersionRange`, via `semver.satisfies()` (never
 * hand-rolled range parsing, per architecture.md).
 *
 * Explicit, deliberate choice on prerelease handling: called with `{ includePrerelease: false }`
 * (semver's own default, made explicit here rather than left implicit) — a prerelease core
 * version (e.g. "1.3.0-beta.1") does NOT satisfy a plain stable range (e.g. "^1.2.0") unless the
 * manifest's own range itself opts into that exact prerelease line (e.g. "^1.3.0-beta.1" or
 * similar). Rationale: an extension declaring a stable compatibility range should never silently
 * activate against unstable, in-flight core behavior just because the numeric range happens to
 * overlap — that would defeat the purpose of the negotiation gate. Exported (not just internal)
 * so this behavior is directly unit-testable independent of the fixed `EXTENSION_API_VERSION`
 * constant (see register-extension.test.ts).
 */
export function isApiVersionCompatible(
  coreVersion: string,
  manifestApiVersionRange: string
): boolean {
  return semver.satisfies(coreVersion, manifestApiVersionRange, { includePrerelease: false })
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
  hooksFactory: () => ExtensionHooks
): { manifest: ExtensionManifest; hooks: ExtensionHooks } {
  if (!REVERSE_DNS_NAME_PATTERN.test(manifest.name)) {
    throw new ExtensionRegistrationError(
      'invalid-name',
      `Extension manifest name "${manifest.name}" is not reverse-DNS style (expected e.g. "com.acme.sso-extension")`
    )
  }

  if (!isApiVersionCompatible(EXTENSION_API_VERSION, manifest.apiVersion)) {
    throw new ExtensionRegistrationError(
      'incompatible-version',
      `Extension manifest apiVersion range "${manifest.apiVersion}" is not compatible with core EXTENSION_API_VERSION "${EXTENSION_API_VERSION}"`
    )
  }

  const hooks = hooksFactory()
  return { manifest, hooks }
}
