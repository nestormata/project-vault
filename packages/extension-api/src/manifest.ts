import semver from 'semver'

/**
 * AC1 — the manifest shape an extension author declares, per architecture.md
 * § Extension Manifest Shape.
 */
export type ExtensionCapability = 'auth-provider' | 'notification-channel' | 'ui-panel'

export type ExtensionManifest = {
  /** Reverse-DNS-style identifier, e.g. "com.acme.sso-extension" — validated by registerExtension (AC6). */
  name: string
  /** Exact canonical EXTENSION_API_VERSION this extension was built against (e.g. "1.0.0"). Ranges and wildcards are rejected; "1.0.0" is accepted and "^1.0.0" is rejected. */
  apiVersion: string
  capabilities: ExtensionCapability[]
}

/**
 * AC1/AC7 — this package's own contract version. Must be bumped in lockstep with any change
 * under `src/**` (enforced by `scripts/check-extension-api-version-skew.ts`, AC7) and kept equal
 * to this package's `package.json` `version` field (see `manifest.test.ts`).
 */
export const EXTENSION_API_VERSION = '1.1.0'

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
