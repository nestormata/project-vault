import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'
import { scanAuditBaseline } from './check-audit-baseline.js'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const makeFixtureRoot = useFixtureRoots('audit-baseline-', [])

const ADVISORY_ID = 'GHSA-aaaa-bbbb-cccc'
const AUDIT_CI_JSONC = 'audit-ci.jsonc'

describe('scanAuditBaseline', () => {
  it('passes clean: valid empty allowlist', () => {
    const root = makeFixtureRoot()
    writeFixture(root, AUDIT_CI_JSONC, JSON.stringify({ high: true, allowlist: [] }))

    expect(scanAuditBaseline(root)).toEqual({ violations: [] })
  })

  it('passes clean: a valid non-expired object-form entry with notes and expiry', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      AUDIT_CI_JSONC,
      JSON.stringify({
        high: true,
        allowlist: [
          {
            [ADVISORY_ID]: {
              notes: 'Fix already started upstream, tracked in JIRA-123',
              expiry: '2099-01-01',
            },
          },
        ],
      })
    )

    expect(scanAuditBaseline(root)).toEqual({ violations: [] })
  })

  it('fails: an expired entry', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      AUDIT_CI_JSONC,
      JSON.stringify({
        high: true,
        allowlist: [
          {
            [ADVISORY_ID]: {
              notes: 'Some justification',
              expiry: '2020-01-01',
            },
          },
        ],
      })
    )

    const { violations } = scanAuditBaseline(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ entryKey: ADVISORY_ID })
    expect(violations[0]?.reason).toContain('expiry')
  })

  it('fails: an entry missing "notes"', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      AUDIT_CI_JSONC,
      JSON.stringify({
        high: true,
        allowlist: [
          {
            [ADVISORY_ID]: {
              expiry: '2099-01-01',
            },
          },
        ],
      })
    )

    const { violations } = scanAuditBaseline(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ entryKey: ADVISORY_ID })
    expect(violations[0]?.reason).toContain('notes')
  })

  it("fails: a bare-string allowlist entry (rejected by this repo's policy)", () => {
    const root = makeFixtureRoot()
    writeFixture(root, AUDIT_CI_JSONC, JSON.stringify({ high: true, allowlist: [ADVISORY_ID] }))

    const { violations } = scanAuditBaseline(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ entryKey: ADVISORY_ID })
    expect(violations[0]?.reason).toContain('bare-string')
  })

  it('passes clean: an inactive (active: false) entry skips expiry/notes validation', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      AUDIT_CI_JSONC,
      JSON.stringify({
        high: true,
        allowlist: [
          {
            [ADVISORY_ID]: {
              active: false,
            },
          },
        ],
      })
    )

    expect(scanAuditBaseline(root)).toEqual({ violations: [] })
  })

  it('fails closed: a missing audit-ci.jsonc file', () => {
    const root = makeFixtureRoot()

    const { violations } = scanAuditBaseline(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.entryKey).toBe('<file>')
    expect(violations[0]?.reason).toContain('not found')
  })

  it('fails closed: a malformed (unparseable) audit-ci.jsonc file', () => {
    const root = makeFixtureRoot()
    writeFixture(root, AUDIT_CI_JSONC, '{ this is not valid json')

    const { violations } = scanAuditBaseline(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.entryKey).toBe('<file>')
    expect(violations[0]?.reason).toMatch(/JSON/i)
  })

  it('exits non-zero and reports the violating entry on the CLI', () => {
    const root = makeFixtureRoot()
    writeFixture(root, AUDIT_CI_JSONC, JSON.stringify({ high: true, allowlist: [ADVISORY_ID] }))

    const script = resolve(repositoryRoot, 'scripts/check-audit-baseline.ts')
    const tsxLoader = resolve(repositoryRoot, 'node_modules/tsx/dist/esm/index.mjs')

    let stderr = ''
    let threw = false
    try {
      execFileSync(process.execPath, ['--import', tsxLoader, script], {
        cwd: root,
        stdio: 'pipe',
      })
    } catch (error) {
      threw = true
      stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? ''
    }
    expect(threw).toBe(true)
    expect(stderr).toContain(ADVISORY_ID)
  })

  it('exits zero against the real repository state', () => {
    const script = resolve(repositoryRoot, 'scripts/check-audit-baseline.ts')
    const tsxLoader = resolve(repositoryRoot, 'node_modules/tsx/dist/esm/index.mjs')

    const stdout = execFileSync(process.execPath, ['--import', tsxLoader, script], {
      cwd: repositoryRoot,
      stdio: 'pipe',
    }).toString()
    expect(stdout).toContain('audit-ci.jsonc baseline check passed')
  })
})
