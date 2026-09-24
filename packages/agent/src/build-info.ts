/**
 * Story 43.6 (decision D2) — the agent's own build identity, reported by `pvault --version` next
 * to the CLI's so a skewed or stale embedded agent is diagnosable. The committed values are always
 * the unstamped `'dev'`/`null` defaults (`pnpm check-build-info-unstamped`); only the release
 * workflow stamps them, together with the CLI's, via `scripts/stamp-build-info.ts`.
 *
 * Exposed through the `./build-info` subpath export only, never re-exported from `index.ts`, so
 * bundles that import just `.` are unaffected.
 */
export type BuildInfo = { version: string; commit: string | null }

export const AGENT_BUILD_INFO: BuildInfo = { version: 'dev', commit: null }
