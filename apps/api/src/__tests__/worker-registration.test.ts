import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import journal from '../../../../packages/db/src/migrations/meta/_journal.json' with { type: 'json' }

const MAIN_TS_PATH = resolve(process.cwd(), 'src/main.ts')
const SRC_DIR = resolve(process.cwd(), 'src')
const REGISTER_SCHEDULES = 'registerSchedules({'
const REGISTER_WORKERS = 'registerWorkers({'
// Mirrors pg-boss's own attorney.js `assertObjectName`: alphanumeric, underscore, period,
// hyphen, or forward slash only — notably NOT a colon (see apps/api's pg-boss job-name
// incident: colon-separated names like 'payment:expiry-alert' threw an uncaught AssertionError
// out of registerSchedules on first vault unseal in every real deployment).
const PG_BOSS_NAME_PATTERN = /^[\w.\-/]+$/

function collectTsFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry)
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      files.push(...collectTsFiles(fullPath))
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      files.push(fullPath)
    }
  }
  return files
}

const stripInterpolation = (value: string): string => value.replace(/\$\{[^}]*\}/g, '')

// `indexOf('})')` stops at the first `{}` it meets — main.ts's backup-enabled ternary has a
// `: {})` false-branch that trips that naive search well before the real end of the call, silently
// truncating the block (and the names after it, like 'audit-storage/check', were never checked).
// Balance braces/parens from the marker's already-open `(` and `{` instead.
function extractBalancedBlock(source: string, marker: string): string {
  const start = source.indexOf(marker)
  if (start === -1) throw new Error(`marker not found: ${marker}`)
  let depth = 2 // marker already opened one '(' and one '{'
  let i = start + marker.length
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === '(' || source[i] === '{') depth++
    else if (source[i] === ')' || source[i] === '}') depth--
  }
  return source.slice(start, i)
}

describe('credentials/prune-versions registration (AC-8 R3)', () => {
  it('is registered in both the schedules and workers maps in main.ts', () => {
    // This test intentionally inspects the static source file so worker registration cannot drift.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const mainSource = readFileSync(MAIN_TS_PATH, 'utf-8')
    const schedulesBlock = extractBalancedBlock(mainSource, REGISTER_SCHEDULES)
    const workersBlock = extractBalancedBlock(mainSource, REGISTER_WORKERS)

    expect(schedulesBlock).toContain("'credentials/prune-versions'")
    expect(workersBlock).toContain("'credentials/prune-versions'")
  })

  it('uses pg-boss compatible queue names', () => {
    // This test intentionally inspects the static source file so queue naming cannot drift.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const mainSource = readFileSync(MAIN_TS_PATH, 'utf-8')
    const schedulesBlock = extractBalancedBlock(mainSource, REGISTER_SCHEDULES)
    const workersBlock = extractBalancedBlock(mainSource, REGISTER_WORKERS)
    // Matches every top-level string-literal key, whichever registration shape follows it:
    // `{ cron }`, `{ handler, options }`, or a plain arrow-function worker.
    const extractKeys = (block: string): string[] =>
      [...block.matchAll(/^\s*'([^']+)':/gm)].map((match) => match[1] as string)
    // Computed keys (e.g. `[ROTATION_RECOVER_JOB]:`) resolve to a `const FOO_JOB = '...'`
    // declared above — pull those literal values in too so they're covered by the charset check.
    const constJobNames = [...mainSource.matchAll(/const [A-Z0-9_]+_JOB = '([^']+)'/g)].map(
      (match) => match[1] as string
    )

    const queueNames = [...extractKeys(schedulesBlock), ...extractKeys(workersBlock)]
    expect(queueNames.length).toBeGreaterThan(20)
    expect(constJobNames.length).toBeGreaterThan(0)

    expect(queueNames).toEqual(
      expect.arrayContaining([
        'prune-revoked-tokens',
        'mfa/prune-totp-used-codes',
        'mfa/prune-pending-mfa-sessions',
        'mfa/prune-pending',
        'security/check-failed-auth-threshold',
        'security/prune-failed-auth-attempts',
        'credentials/prune-versions',
        'import/cleanup-expired',
        'notification/email-catchup',
        'notification/slack-catchup',
        'notification/deliver-catchup',
        'notification/dlq-cleanup',
        'notification/send-digest',
        'payment/expiry-alert',
        'cert/expiry-alert',
        'domain/expiry-alert',
        'credential/expiry-alert',
        'machine-key/expiry-alert',
        'machine-key/overlap-revoke',
        'machine-key/overlap-alert',
        'machine-key/dormancy-check',
        'user/dormancy-check',
        'audit/webhook-forward-catchup',
        'audit/s3-forward-daily',
        'audit/retention-prune',
        'audit-storage/check',
        'key-custody/check',
        'resource-usage/check',
      ])
    )
    for (const name of [...queueNames, ...constJobNames]) {
      expect(name).toMatch(PG_BOSS_NAME_PATTERN)
    }
  })

  it('every boss.send() dispatch and singletonKey across apps/api/src is pg-boss compatible', () => {
    const sendNamePattern = /boss\.send\(\s*(['"`])((?:(?!\1)[\s\S])*?)\1/g
    const singletonKeyPattern = /singletonKey:\s*(['"`])((?:(?!\1)[\s\S])*?)\1/g

    let checkedAtLeastOne = false
    for (const file of collectTsFiles(SRC_DIR)) {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const source = readFileSync(file, 'utf-8')
      for (const match of source.matchAll(sendNamePattern)) {
        checkedAtLeastOne = true
        expect(stripInterpolation(match[2] as string)).toMatch(PG_BOSS_NAME_PATTERN)
      }
      for (const match of source.matchAll(singletonKeyPattern)) {
        checkedAtLeastOne = true
        expect(stripInterpolation(match[2] as string)).toMatch(PG_BOSS_NAME_PATTERN)
      }
    }
    expect(checkedAtLeastOne).toBe(true)
  })

  it('keeps the projects migration before the credentials migration (AC-11B O4)', () => {
    const projects = journal.entries.find((entry) => entry.tag === '0013_projects')
    const credentials = journal.entries.find((entry) => entry.tag === '0014_credentials')

    expect(projects).toBeDefined()
    expect(credentials).toBeDefined()
    expect(projects?.idx).toBeLessThan(credentials?.idx ?? -1)
  })

  it('registers notification workers (Story 3.1 AC-9)', () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const mainSource = readFileSync(MAIN_TS_PATH, 'utf-8')
    const workersBlock = extractBalancedBlock(mainSource, REGISTER_WORKERS)

    expect(workersBlock).toContain("'notification/email'")
    expect(workersBlock).toContain("'notification/slack'")
    expect(workersBlock).toContain("'notification/backfill-pending-delivery'")
    expect(workersBlock).toContain("'notification/deliver'")
    expect(workersBlock).toContain("'notification/deliver-catchup'")
    expect(workersBlock).toContain("'notification/send-digest'")
  })
})
