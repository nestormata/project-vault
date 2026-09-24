import type { BuildInfo } from '@project-vault/agent/build-info'

/**
 * Story 43.6 (decision D2) — the CLI's build identity. Never read from `package.json` (permanently
 * `0.0.1`, see docs/releasing.md) and never from the runtime environment. The committed value is
 * always the unstamped `'dev'`/`null` default; the release workflow stamps this file and the
 * agent's together via `scripts/stamp-build-info.ts`, and `pnpm check-build-info-unstamped` keeps a
 * locally stamped copy from being committed.
 */
export const CLI_BUILD_INFO: BuildInfo = { version: 'dev', commit: null }

/** The only download location the CLI ever prints — never a server-supplied URL (AC-2). */
export const PVAULT_RELEASES_URL = 'https://github.com/nestormata/project-vault/releases'

export type { BuildInfo }

function describe(label: string, info: BuildInfo): string {
  return `${label} ${info.version} (commit ${info.commit ?? 'unknown'})`
}

/**
 * `pvault --version` output (AC-4): two stable stdout lines (`pvault <version> (commit <sha>)`,
 * then the bundled agent), plus a stderr warning when the two were built from different sources.
 */
export function formatVersionOutput(
  cli: BuildInfo,
  agent: BuildInfo
): { stdout: string; stderr: string } {
  const stdout = `${describe('pvault', cli)}\n${describe('agent ', agent)}\n`
  const skewed = cli.version !== agent.version || cli.commit !== agent.commit
  const stderr = skewed
    ? 'warning: pvault and its agent were built from different sources; rebuild both (pnpm --filter "@project-vault/cli..." build)\n'
    : ''
  return { stdout, stderr }
}
