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
}

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
// Story 25.3 AC1/Task 1 — bumped again as an additive-minor (3.1.0 -> 3.2.0): `UIPanelContext`
// gains `resourceId?`, `identity`, `orgId`, `projectId?`, `locale`, `theme` (see
// `hooks/ui-panel.ts`). TypeScript's bivariant parameter checking for method-shorthand object
// literals (`onRenderPanel(context) {...}`) means an existing extension's narrower-typed
// implementation stays structurally assignable to the widened `UIPanel` type without a
// coordinated update — confirmed during this story's own Pre-mortem Analysis elicitation round —
// so an additive-minor bump (not a major) remains correct.
export const EXTENSION_API_VERSION = '3.2.0'

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
