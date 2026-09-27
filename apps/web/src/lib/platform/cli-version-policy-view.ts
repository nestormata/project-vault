// Story 43.7 AC-1 / AC-4: view-model helpers for the CLI Version Policy section on
// /platform/upgrade. Deliberately web-local (D6): only strict X.Y.Z triples are compared, which is
// all the API ever publishes for `current`/`minimumSupported`; withdrawn matching is exact string
// equality, as in the CLI and the API. No prerelease precedence is needed here.
import type { CliVersionPolicy } from '$lib/api/platform.js'

/**
 * The fixed reason the API gives every CLI_WITHDRAWN_VERSIONS entry. Source of truth:
 * apps/api/src/modules/client-versions/policy.ts `ENV_WITHDRAWN_REASON` (a parity test reads that
 * file as text, so a change there fails the web suite instead of silently hiding the D5 note).
 */
export const ADMINISTRATOR_WITHDRAWN_REASON = "Withdrawn by this server's administrator."

const RELEASE_TRIPLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function parseReleaseTriple(value: string): [number, number, number] | null {
  const match = RELEASE_TRIPLE.exec(value)
  if (!match) return null
  const [, major = '', minor = '', patch = ''] = match
  const triple: [number, number, number] = [Number(major), Number(minor), Number(patch)]
  return triple.every((part) => Number.isSafeInteger(part)) ? triple : null
}

/** True only when both are strict X.Y.Z and `candidate` is numerically above `baseline`. */
function isTripleAbove(candidate: string, baseline: string): boolean {
  const above = parseReleaseTriple(candidate)
  const base = parseReleaseTriple(baseline)
  if (!above || !base) return false
  const [aboveMajor, aboveMinor, abovePatch] = above
  const [baseMajor, baseMinor, basePatch] = base
  if (aboveMajor !== baseMajor) return aboveMajor > baseMajor
  if (aboveMinor !== baseMinor) return aboveMinor > baseMinor
  return abovePatch > basePatch
}

/**
 * Mirrors 43.6's boot warnings (CLI_VERSION_POLICY_SELF_CONTRADICTION): minimum above the
 * server's release, then the server's own release withdrawn. No release → nothing to contradict.
 */
export function deriveCliPolicyWarnings(policy: CliVersionPolicy): string[] {
  const { current, minimumSupported, withdrawn } = policy.cli
  if (current === null) return []
  const warnings: string[] = []
  if (minimumSupported !== null && isTripleAbove(minimumSupported, current)) {
    warnings.push(
      `The minimum supported version (${minimumSupported}) is above this server's release (${current}). Every pvault up to this server's own release is told it is below the minimum.`
    )
  }
  if (withdrawn.some((entry) => entry.version === current)) {
    warnings.push(
      `This server's own release (${current}) is in the withdrawn list. pvault ${current}, the matching client for this server, refuses to run.`
    )
  }
  return warnings
}

export type CurrentCliReleaseView =
  | { kind: 'version'; version: string }
  | { kind: 'development' }
  | { kind: 'non_strict_release'; serverVersion: string }

/** `current` is null for a dev build and for a release whose version is not plain X.Y.Z. */
export function describeCurrent(policy: CliVersionPolicy): CurrentCliReleaseView {
  if (policy.cli.current !== null) return { kind: 'version', version: policy.cli.current }
  if (policy.server.versionSource === 'development') return { kind: 'development' }
  return { kind: 'non_strict_release', serverVersion: policy.server.version }
}

/** D5: the only provenance hint the public payload allows — 43.6's fixed env reason. */
export function hasAdministratorWithdrawals(policy: CliVersionPolicy): boolean {
  return policy.cli.withdrawn.some((entry) => entry.reason === ADMINISTRATOR_WITHDRAWN_REASON)
}
