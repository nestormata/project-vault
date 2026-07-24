/**
 * AC1 — the manifest shape an extension author declares, per architecture.md
 * § Extension Manifest Shape.
 */
export type ExtensionCapability = 'auth-provider' | 'notification-channel' | 'ui-panel'

export type ExtensionManifest = {
  /** Reverse-DNS-style identifier, e.g. "com.acme.sso-extension" — validated by registerExtension (AC6). */
  name: string
  /** semver range this extension is compatible with (e.g. "^1.2.0") — validated against EXTENSION_API_VERSION (AC4/5). */
  apiVersion: string
  capabilities: ExtensionCapability[]
}

/**
 * AC1/AC7 — this package's own contract version. Must be bumped in lockstep with any change
 * under `src/**` (enforced by `scripts/check-extension-api-version-skew.ts`, AC7) and kept equal
 * to this package's `package.json` `version` field (see `manifest.test.ts`).
 */
export const EXTENSION_API_VERSION = '1.0.0'

/**
 * AC1/AC3 (Task 3) — thin, typed identity function. Gives extension authors autocomplete and
 * type-checking on their manifest object without any runtime effect; validation happens later,
 * at `registerExtension()` time.
 */
export function defineExtension(manifest: ExtensionManifest): ExtensionManifest {
  return manifest
}
