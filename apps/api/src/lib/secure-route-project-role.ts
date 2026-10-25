import type { OrgRole } from '../plugins/require-org-role.js'

/**
 * Story 69.17 / 69.18 — which project-role gate a registered route gets. One decision, made once at
 * registration from the route's method and URL, its security object, and who owns that security:
 *
 * - `pv`: PV's own route, or an override without `replaceSecurity` (it keeps PV's security).
 * - `extension`: an `apiRoutes` add, or an override with `replaceSecurity`, from a manifest that
 *   declares the contract version that defaults the gate (`PROJECT_ROLE_DEFAULT_SINCE`).
 * - `extension-legacy`: the same, from an older manifest; it keeps the behaviour it was written
 *   against (no default), and the boot log names the route.
 */
export type ExtensionProjectRolePolicy = 'extension' | 'extension-legacy'
export type ProjectRolePolicy = 'pv' | ExtensionProjectRolePolicy

/** Why an extension write under `:projectId` runs without the gate (logged at boot). */
export type ProjectRoleUngatedReason = 'declared_viewer' | 'legacy_contract' | 'unauthenticated'

export type ProjectRoleGate = {
  /** null when no check runs. */
  minimumProjectRole: OrgRole | null
  /** Set only for an extension's own project write that runs ungated. */
  ungated: ProjectRoleUngatedReason | null
}

/** The first `@project-vault/extension-api` release whose routes get the default gate. */
export const PROJECT_ROLE_DEFAULT_SINCE = '3.37.0'

const PROJECT_ID_SEGMENT = /(?:^|\/):projectId(?:\/|$)/
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export function hasProjectIdParam(url: string): boolean {
  return PROJECT_ID_SEGMENT.test(url)
}

/** `MAJOR.MINOR.PATCH` as one sortable number, or null when it is not three whole numbers. */
function versionRank(version: string): number | null {
  const parts = version.split('.').map(Number)
  if (parts.length !== 3 || !parts.every(Number.isInteger)) return null
  const [major = 0, minor = 0, patch = 0] = parts
  return major * 1_000_000 + minor * 1_000 + patch
}

const DEFAULT_SINCE_RANK = versionRank(PROJECT_ROLE_DEFAULT_SINCE) ?? 0

/**
 * `registerExtension()` already accepted `apiVersion` as a canonical `MAJOR.MINOR.PATCH` in the
 * host's supported range (no prerelease), so comparing the three numbers is exact. Anything else
 * gets the default gate (fail closed).
 */
export function projectRolePolicyFor(apiVersion: string): ExtensionProjectRolePolicy {
  const rank = versionRank(apiVersion)
  return rank === null || rank >= DEFAULT_SINCE_RANK ? 'extension' : 'extension-legacy'
}

const NO_GATE: ProjectRoleGate = { minimumProjectRole: null, ungated: null }
const MEMBER_GATE: ProjectRoleGate = { minimumProjectRole: 'member', ungated: null }

function ungatedFor(policy: ProjectRolePolicy, reason: ProjectRoleUngatedReason): ProjectRoleGate {
  return { minimumProjectRole: null, ungated: policy === 'pv' ? null : reason }
}

type GateSecurity = { requireAuth?: boolean; minimumProjectRole?: OrgRole } | undefined

/** A project write that declares no role, or `'viewer'`. */
function undeclaredGate(security: GateSecurity, policy: ProjectRolePolicy): ProjectRoleGate {
  if (security?.minimumProjectRole === 'viewer') return ungatedFor(policy, 'declared_viewer')
  if (policy === 'pv') return MEMBER_GATE
  if (policy === 'extension-legacy') return ungatedFor(policy, 'legacy_contract')
  // An anonymous extension route has no caller to rank. A PV route keeps the default, so its
  // registration fails (`assertProjectRoleConfig`) instead of shipping an anonymous project write.
  return security?.requireAuth === false ? ungatedFor(policy, 'unauthenticated') : MEMBER_GATE
}

export function resolveProjectRoleGate(input: {
  method: string
  url: string
  security: GateSecurity
  policy: ProjectRolePolicy
}): ProjectRoleGate {
  const declared = input.security?.minimumProjectRole
  if (declared !== undefined && declared !== 'viewer') {
    return { minimumProjectRole: declared, ungated: null }
  }
  const projectWrite = MUTATING.has(input.method) && hasProjectIdParam(input.url)
  return projectWrite ? undeclaredGate(input.security, input.policy) : NO_GATE
}
