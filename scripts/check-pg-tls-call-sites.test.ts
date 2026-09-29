import { describe, expect, it } from 'vitest'

/**
 * Story 43.16 AC-3 (grep guard): every Postgres client construction in the api runtime, the db
 * package and the operator scripts must pass the pinned private-CA options — `pgTlsOptions()` for
 * postgres.js, `pgBossConnectionOptions()` for pg-boss (node-postgres). A new call site that
 * forgets them would silently skip certificate pinning (and the DB client certificate) on the Fly
 * demo, so it fails CI here.
 *
 * Sources are loaded with `import.meta.glob` (static, build-time globs), so this scan needs no
 * dynamic filesystem reads.
 */
const SOURCES: Record<string, string> = import.meta.glob(
  [
    '../apps/api/src/**/*.ts',
    '../packages/db/src/**/*.ts',
    './**/*.ts',
    '!**/*.test.ts',
    '!**/*.d.ts',
    '!**/node_modules/**',
    '!**/dist/**',
  ],
  { query: '?raw', import: 'default', eager: true }
)

const CLIENT_CONSTRUCTION = /\bpostgres\(|\bnew PgBoss\(/
const TLS_OPTIONS = /pgTlsOptions\(|pgBossConnectionOptions\(/
// A call's options may wrap onto the following lines (prettier), so the TLS options must appear
// on the construction line or within the next few lines.
const CALL_WINDOW_LINES = 6

type CallSite = { file: string; line: number; window: string }

function repoRelative(globKey: string): string {
  return globKey.startsWith('./') ? `scripts/${globKey.slice(2)}` : globKey.replace(/^\.\.\//, '')
}

function isCommentLine(text: string): boolean {
  const trimmed = text.trimStart()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

function callSites(): CallSite[] {
  return Object.entries(SOURCES).flatMap(([key, source]) => {
    const lines = source.split('\n')
    return lines.flatMap((text, index) =>
      !isCommentLine(text) && CLIENT_CONSTRUCTION.test(text)
        ? [
            {
              file: repoRelative(key),
              line: index + 1,
              window: lines.slice(index, index + CALL_WINDOW_LINES).join('\n'),
            },
          ]
        : []
    )
  })
}

describe('Postgres client call sites pin the private CA (Story 43.16 AC-3)', () => {
  it('scans the known runtime and operator call sites', () => {
    const files = new Set(callSites().map((site) => site.file))
    for (const expected of [
      'apps/api/src/main.ts',
      'apps/api/src/lib/db.ts',
      'apps/api/src/lib/boss.ts',
      'apps/api/src/scripts/sso-qa.ts',
      'packages/db/src/index.ts',
      'packages/db/src/extension-db.ts',
      'packages/db/src/scripts/guarded-migrate.ts',
      'packages/db/src/scripts/extension-grants.ts',
      'scripts/lib/run-db-check.ts',
      'scripts/check-admin-pool.ts',
    ]) {
      expect(files).toContain(expected)
    }
  })

  it('every postgres()/new PgBoss() construction passes the pinned TLS options', () => {
    const offenders = callSites()
      .filter((site) => !TLS_OPTIONS.test(site.window))
      .map((site) => `${site.file}:${site.line}`)
    expect(offenders).toEqual([])
  })

  it('flags a construction without the TLS options (guard self-test)', () => {
    const window = 'const sql = postgres(url, { max: 1 })\nawait sql`select 1`'
    expect(CLIENT_CONSTRUCTION.test(window) && !TLS_OPTIONS.test(window)).toBe(true)
  })
})
