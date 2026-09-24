/**
 * Story 43.6 (decision D2) — the one template both build-info modules are stamped from, so the
 * CLI's and the agent's identities can never be written in two different shapes. Shared by
 * `scripts/stamp-build-info.ts` (release workflow) and `scripts/check-build-info-unstamped.ts`
 * (CI guard that the committed copies stay `'dev'`/`null`).
 */
export type BuildInfoValue = { version: string; commit: string | null }

export const BUILD_INFO_FILES = [
  { path: 'packages/agent/src/build-info.ts', constName: 'AGENT_BUILD_INFO' },
  { path: 'packages/cli/src/build-info.ts', constName: 'CLI_BUILD_INFO' },
] as const

export const DEV_BUILD_INFO: BuildInfoValue = { version: 'dev', commit: null }

/** Same tag shape `container-publish.yml` validates, without the leading `v`. */
export const RELEASE_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+$/
export const SHORT_COMMIT_PATTERN = /^[0-9a-f]{7}$/

function quote(value: string | null): string {
  return value === null ? 'null' : `'${value}'`
}

export function renderBuildInfoLine(constName: string, info: BuildInfoValue): string {
  return `export const ${constName}: BuildInfo = { version: ${quote(info.version)}, commit: ${quote(info.commit)} }`
}

function constLinePattern(constName: string): RegExp {
  return new RegExp(`^export const ${constName}: BuildInfo = .*$`, 'm')
}

/** The constant's current line in `source`, or `null` when it is missing. */
export function findBuildInfoLine(source: string, constName: string): string | null {
  return constLinePattern(constName).exec(source)?.[0] ?? null
}

export function stampBuildInfoSource(
  source: string,
  constName: string,
  info: BuildInfoValue
): string {
  if (findBuildInfoLine(source, constName) === null) {
    throw new Error(`build-info constant ${constName} not found`)
  }
  return source.replace(constLinePattern(constName), renderBuildInfoLine(constName, info))
}
