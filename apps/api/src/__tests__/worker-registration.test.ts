import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import journal from '../../../../packages/db/src/migrations/meta/_journal.json' with { type: 'json' }

describe('credentials/prune-versions registration (AC-8 R3)', () => {
  it('is registered in both the schedules and workers maps in main.ts', () => {
    // This test intentionally inspects the static source file so worker registration cannot drift.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const mainSource = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf-8')
    const schedulesBlock = mainSource.slice(
      mainSource.indexOf('registerSchedules({'),
      mainSource.indexOf('})', mainSource.indexOf('registerSchedules({'))
    )
    const workersBlock = mainSource.slice(
      mainSource.indexOf('registerWorkers({'),
      mainSource.indexOf('})', mainSource.indexOf('registerWorkers({'))
    )

    expect(schedulesBlock).toContain("'credentials/prune-versions'")
    expect(workersBlock).toContain("'credentials/prune-versions'")
  })

  it('uses pg-boss compatible queue names', () => {
    // This test intentionally inspects the static source file so queue naming cannot drift.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const mainSource = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf-8')
    const queueNames = [...mainSource.matchAll(/'([^']+)': \{/g)]
      .map((match) => match[1])
      .filter((name): name is string => typeof name === 'string')

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
      ])
    )
    expect(queueNames.every((name) => /^[A-Za-z0-9_.\-/]+$/.test(name))).toBe(true)
  })

  it('keeps the projects migration before the credentials migration (AC-11B O4)', () => {
    const projects = journal.entries.find((entry) => entry.tag === '0013_projects')
    const credentials = journal.entries.find((entry) => entry.tag === '0014_credentials')

    expect(projects).toBeDefined()
    expect(credentials).toBeDefined()
    expect(projects?.idx).toBeLessThan(credentials?.idx ?? -1)
  })
})
