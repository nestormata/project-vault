import { OperationalEvent, SYSTEM_TRACE_ID } from '@project-vault/shared'
import type { ReleaseVersion } from '../../lib/package-version.js'

/**
 * Story 43.6 (decisions D3, D5) — the effective client-version policy served by
 * `GET /api/v1/client-version-policy`. Pure functions only: resolved once at boot from the baked
 * upstream policy plus the operator's env vars (tighten-only), then combined per request with the
 * server's own release version.
 */

/** Strict `X.Y.Z` — no prerelease, no build metadata, no leading `v`. */
export const STRICT_RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
/** A prerelease identifier: numeric without a leading zero, or alphanumeric with a non-digit. */
const PRERELEASE_NUMERIC_ID = /^(0|[1-9]\d*)$/
const PRERELEASE_CHARS = /^[0-9a-zA-Z-]+$/
const NON_DIGIT = /[a-zA-Z-]/

function isPrereleaseIdentifier(id: string): boolean {
  return PRERELEASE_NUMERIC_ID.test(id) || (PRERELEASE_CHARS.test(id) && NON_DIGIT.test(id))
}

/** Strict SemVer 2.0.0 with an optional prerelease; build metadata and a leading `v` rejected. */
export function isStrictSemver(version: string): boolean {
  const dash = version.indexOf('-')
  if (dash === -1) return STRICT_RELEASE_VERSION.test(version)
  return (
    STRICT_RELEASE_VERSION.test(version.slice(0, dash)) &&
    version
      .slice(dash + 1)
      .split('.')
      .every(isPrereleaseIdentifier)
  )
}

export const MAX_ENV_WITHDRAWN_VERSIONS = 50

/**
 * The limits the pvault CLI's policy validator enforces (packages/cli `semver-precedence.ts` and
 * `version-policy-response.ts`; a parity test there imports these). The CLI rejects the WHOLE
 * policy when any single value breaks them, which would silently stop withdrawals from being
 * enforced — so the server refuses to boot rather than serve such a policy.
 */
export const CLI_MAX_VERSION_LENGTH = 128
export const CLI_MAX_WITHDRAWN_ENTRIES = 100
export const CLI_MAX_REASON_CODE_POINTS = 200
const NUMERIC_IDENTIFIER = /^\d+$/
const CLI_VERSION_LIMITS =
  'strict semver (X.Y.Z or X.Y.Z-prerelease, no "v", no build metadata), at most ' +
  `${CLI_MAX_VERSION_LENGTH} characters, every numeric part at most ${Number.MAX_SAFE_INTEGER}`

/** True when the pvault CLI's strict-semver parser accepts `version`. */
export function isCliAcceptedVersion(version: string): boolean {
  if (version.length > CLI_MAX_VERSION_LENGTH || !isStrictSemver(version)) return false
  const dash = version.indexOf('-')
  const core = (dash === -1 ? version : version.slice(0, dash)).split('.')
  const prerelease = dash === -1 ? [] : version.slice(dash + 1).split('.')
  return [...core, ...prerelease.filter((id) => NUMERIC_IDENTIFIER.test(id))].every((part) =>
    Number.isSafeInteger(Number(part))
  )
}

/** A strict `X.Y.Z` release version the pvault CLI's parser accepts. */
export function isCliAcceptedReleaseVersion(version: string): boolean {
  return STRICT_RELEASE_VERSION.test(version) && isCliAcceptedVersion(version)
}

const DISPLAYED_VALUE_MAX = 64

function displayValue(value: string): string {
  return value.length > DISPLAYED_VALUE_MAX ? `${value.slice(0, DISPLAYED_VALUE_MAX)}…` : value
}

function effectiveWithdrawnCountError(count: number): string | null {
  return count > CLI_MAX_WITHDRAWN_ENTRIES
    ? `the effective withdrawn CLI version list (built-in plus CLI_WITHDRAWN_VERSIONS) has ${count} versions; at most ${CLI_MAX_WITHDRAWN_ENTRIES} are allowed`
    : null
}
/** The env var carries versions only, never free text, so env-withdrawn entries get this reason. */
export const ENV_WITHDRAWN_REASON = "Withdrawn by this server's administrator."

export type BakedCliVersionPolicy = {
  minimumSupported: string | null
  withdrawn: { version: string; reason: string }[]
}

export type EffectiveCliVersionPolicy = {
  minimumSupported: string | null
  withdrawn: { version: string; reason: string; source: 'baked' | 'env' }[]
}

export type CliVersionPolicyEnv = { minimumSupported?: string; withdrawn: string[] }

type BootLogger = {
  info: (payload: unknown, message?: string) => void
  warn: (payload: unknown, message?: string) => void
}

/**
 * Parses `CLI_WITHDRAWN_VERSIONS`. `bakedVersions` (the built-in withdrawn list) only counts
 * towards the CLI's limit on the effective, merged list.
 */
export function parseCliWithdrawnVersions(
  raw: string | undefined,
  bakedVersions: readonly string[] = []
): { ok: true; versions: string[] } | { ok: false; error: string } {
  const versions = [
    ...new Set(
      (raw ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    ),
  ]
  const bad = versions.find((version) => !isCliAcceptedVersion(version))
  if (bad !== undefined) {
    return {
      ok: false,
      error: `CLI_WITHDRAWN_VERSIONS entry "${displayValue(bad)}" is not a version the pvault CLI accepts: ${CLI_VERSION_LIMITS}`,
    }
  }
  if (versions.length > MAX_ENV_WITHDRAWN_VERSIONS) {
    return {
      ok: false,
      error: `CLI_WITHDRAWN_VERSIONS lists ${versions.length} versions; at most ${MAX_ENV_WITHDRAWN_VERSIONS} are allowed`,
    }
  }
  const countError = effectiveWithdrawnCountError(new Set([...bakedVersions, ...versions]).size)
  if (countError !== null) return { ok: false, error: countError }
  return { ok: true, versions }
}

/** Numeric `X.Y.Z` comparison; both inputs must already match `STRICT_RELEASE_VERSION`. */
function compareReleaseVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** `current` for the CLI: the server's release version when it is strict `X.Y.Z`, else `null`. */
export function strictReleaseVersionOrNull(release: ReleaseVersion): string | null {
  return release.isRelease && isCliAcceptedReleaseVersion(release.version) ? release.version : null
}

function effectiveMinimum(
  envMinimum: string | undefined,
  bakedMinimum: string | null,
  logger: BootLogger
): string | null {
  if (!envMinimum) return bakedMinimum
  if (bakedMinimum === null || compareReleaseVersions(envMinimum, bakedMinimum) >= 0) {
    return envMinimum
  }
  logger.warn(
    {
      eventType: OperationalEvent.CLI_VERSION_POLICY_ENV_MINIMUM_IGNORED,
      traceId: SYSTEM_TRACE_ID,
      configured: envMinimum,
      baked: bakedMinimum,
    },
    `CLI_MINIMUM_SUPPORTED_VERSION ${envMinimum} is lower than this release's built-in minimum ${bakedMinimum} and is ignored (the policy can only be tightened)`
  )
  return bakedMinimum
}

function warnOnSelfContradiction(
  policy: EffectiveCliVersionPolicy,
  release: ReleaseVersion,
  logger: BootLogger
): void {
  const current = strictReleaseVersionOrNull(release)
  if (current === null) return
  if (policy.minimumSupported && compareReleaseVersions(policy.minimumSupported, current) > 0) {
    logger.warn(
      {
        eventType: OperationalEvent.CLI_VERSION_POLICY_SELF_CONTRADICTION,
        traceId: SYSTEM_TRACE_ID,
        minimumSupported: policy.minimumSupported,
        serverVersion: current,
      },
      'CLI minimum supported version is above this server release; every CLI will be warned it is below the minimum'
    )
  }
  if (policy.withdrawn.some((entry) => entry.version === current)) {
    logger.warn(
      {
        eventType: OperationalEvent.CLI_VERSION_POLICY_SELF_CONTRADICTION,
        traceId: SYSTEM_TRACE_ID,
        serverVersion: current,
      },
      "this server's own release version is in the withdrawn CLI version list"
    )
  }
}

/** Throws (failing boot) if the pvault CLI would reject the policy as a whole. */
function assertCliAcceptsPolicy(policy: EffectiveCliVersionPolicy): void {
  const { minimumSupported, withdrawn } = policy
  if (minimumSupported !== null && !isCliAcceptedReleaseVersion(minimumSupported)) {
    throw new Error(
      `CLI minimum supported version "${displayValue(minimumSupported)}" is not a strict X.Y.Z version the pvault CLI accepts: ${CLI_VERSION_LIMITS}`
    )
  }
  const countError = effectiveWithdrawnCountError(withdrawn.length)
  if (countError !== null) throw new Error(countError)
  for (const { version, reason } of withdrawn) {
    if (!isCliAcceptedVersion(version)) {
      throw new Error(
        `withdrawn CLI version "${displayValue(version)}" is not a version the pvault CLI accepts: ${CLI_VERSION_LIMITS}`
      )
    }
    if ([...reason].length > CLI_MAX_REASON_CODE_POINTS) {
      throw new Error(
        `the reason for withdrawn CLI version ${version} is longer than ${CLI_MAX_REASON_CODE_POINTS} characters`
      )
    }
  }
}

/**
 * Tighten-only merge (D5): effective minimum = the higher of baked and env; effective withdrawn =
 * baked ∪ env, keeping the baked reason for duplicates. Logs the effective policy once (versions
 * and provenance only, never reasons) plus warnings for self-contradicting configuration. Throws
 * when the result is a policy the pvault CLI would reject (see `CLI_MAX_*`).
 */
export function resolveCliVersionPolicy(
  envPolicy: CliVersionPolicyEnv,
  baked: BakedCliVersionPolicy,
  logger: BootLogger,
  release: ReleaseVersion
): EffectiveCliVersionPolicy {
  const withdrawn: EffectiveCliVersionPolicy['withdrawn'] = baked.withdrawn.map((entry) => ({
    ...entry,
    source: 'baked' as const,
  }))
  const bakedVersions = new Set(baked.withdrawn.map((entry) => entry.version))
  for (const version of envPolicy.withdrawn) {
    if (!bakedVersions.has(version)) {
      withdrawn.push({ version, reason: ENV_WITHDRAWN_REASON, source: 'env' })
    }
  }
  // Validated before the tighten-only comparison, which assumes well-formed release versions.
  assertCliAcceptsPolicy({ minimumSupported: envPolicy.minimumSupported ?? null, withdrawn })
  assertCliAcceptsPolicy({ minimumSupported: baked.minimumSupported, withdrawn: [] })
  const policy = {
    minimumSupported: effectiveMinimum(envPolicy.minimumSupported, baked.minimumSupported, logger),
    withdrawn,
  }
  logger.info(
    {
      eventType: OperationalEvent.CLI_VERSION_POLICY_EFFECTIVE,
      traceId: SYSTEM_TRACE_ID,
      cliVersionPolicy: {
        minimumSupported: policy.minimumSupported,
        withdrawn: withdrawn.map(({ version, source }) => ({ version, source })),
      },
    },
    'effective CLI version policy'
  )
  warnOnSelfContradiction(policy, release, logger)
  return policy
}

export function buildClientVersionPolicyData(
  policy: EffectiveCliVersionPolicy,
  release: ReleaseVersion
) {
  return {
    schemaVersion: 1 as const,
    server: {
      version: release.version,
      versionSource: release.isRelease ? ('release' as const) : ('development' as const),
    },
    clients: {
      cli: {
        current: strictReleaseVersionOrNull(release),
        minimumSupported: policy.minimumSupported,
        withdrawn: policy.withdrawn.map(({ version, reason }) => ({ version, reason })),
      },
    },
  }
}
