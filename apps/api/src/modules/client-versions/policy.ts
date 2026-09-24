import type { ReleaseVersion } from '../../lib/package-version.js'

/**
 * Story 43.6 (decisions D3, D5) — the effective client-version policy served by
 * `GET /api/v1/client-version-policy`. Pure functions only: resolved once at boot from the baked
 * upstream policy plus the operator's env vars (tighten-only), then combined per request with the
 * server's own release version.
 */

/** Strict `X.Y.Z` — no prerelease, no build metadata, no leading `v`. */
export const STRICT_RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
/** Strict SemVer 2.0.0 with an optional prerelease; build metadata and a leading `v` rejected. */
export const STRICT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-(0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(\.(0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?$/
export const MAX_ENV_WITHDRAWN_VERSIONS = 50
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

export function parseCliWithdrawnVersions(
  raw: string | undefined
): { ok: true; versions: string[] } | { ok: false; error: string } {
  const versions = [
    ...new Set(
      (raw ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    ),
  ]
  const bad = versions.find((version) => !STRICT_SEMVER.test(version))
  if (bad !== undefined) {
    return {
      ok: false,
      error: `CLI_WITHDRAWN_VERSIONS entry "${bad}" is not a strict semver version (X.Y.Z or X.Y.Z-prerelease, no "v", no build metadata)`,
    }
  }
  if (versions.length > MAX_ENV_WITHDRAWN_VERSIONS) {
    return {
      ok: false,
      error: `CLI_WITHDRAWN_VERSIONS lists ${versions.length} versions; at most ${MAX_ENV_WITHDRAWN_VERSIONS} are allowed`,
    }
  }
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
  return release.isRelease && STRICT_RELEASE_VERSION.test(release.version) ? release.version : null
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
    { configured: envMinimum, baked: bakedMinimum },
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
      { minimumSupported: policy.minimumSupported, serverVersion: current },
      'CLI minimum supported version is above this server release; every CLI will be warned it is below the minimum'
    )
  }
  if (policy.withdrawn.some((entry) => entry.version === current)) {
    logger.warn(
      { serverVersion: current },
      "this server's own release version is in the withdrawn CLI version list"
    )
  }
}

/**
 * Tighten-only merge (D5): effective minimum = the higher of baked and env; effective withdrawn =
 * baked ∪ env, keeping the baked reason for duplicates. Logs the effective policy once (versions
 * and provenance only, never reasons) plus warnings for self-contradicting configuration.
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
  const policy = {
    minimumSupported: effectiveMinimum(envPolicy.minimumSupported, baked.minimumSupported, logger),
    withdrawn,
  }
  logger.info(
    {
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
