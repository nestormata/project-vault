import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'
import { scanEpicRetroFreshness } from './check-epic-retro-freshness.js'

const ARTIFACTS_DIR = '_bmad-output/implementation-artifacts'
const SPRINT_STATUS_PATH = `${ARTIFACTS_DIR}/sprint-status.yaml`

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scriptPath = resolve(repositoryRoot, 'scripts/check-epic-retro-freshness.ts')
const tsxLoaderPath = resolve(repositoryRoot, 'node_modules/tsx/dist/esm/index.mjs')

const makeFixtureRoot = useFixtureRoots('epic-retro-freshness-', [ARTIFACTS_DIR])

const sprintStatus = (developmentStatusBlock: string) =>
  `generated: 2026-05-31
last_updated: 2026-09-21
project: Fixture Project

development_status:
${developmentStatusBlock}`

describe('scanEpicRetroFreshness', () => {
  it('1. counter absent or zero: no epic flagged', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      SPRINT_STATUS_PATH,
      sprintStatus(`  epic-7-retrospective: done\n  epic-7-retro-pending-closures: 0\n`)
    )

    const { violations, warnings } = scanEpicRetroFreshness(root)
    expect(violations).toEqual([])
    expect(warnings).toEqual([])
  })

  it('2. counter at 1: informational warning only, no violation', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, sprintStatus(`  epic-7-retro-pending-closures: 1\n`))

    const { violations, warnings } = scanEpicRetroFreshness(root)
    expect(violations).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ epicNum: '7', kind: 'pending-one', count: 1 })
  })

  it('3. counter at 2: hard failure naming the epic and count', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, sprintStatus(`  epic-7-retro-pending-closures: 2\n`))

    const { violations, warnings } = scanEpicRetroFreshness(root)
    expect(warnings).toEqual([])
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ epicNum: '7', count: 2 })
  })

  it('4. counter above 2 (e.g. 5): hard failure states the real count, not a rounded threshold', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, sprintStatus(`  epic-7-retro-pending-closures: 5\n`))

    const { violations } = scanEpicRetroFreshness(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ epicNum: '7', count: 5 })
  })

  it('5. malformed counter value: warning, not silently coerced to 0, not a hard failure', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, sprintStatus(`  epic-7-retro-pending-closures: abc\n`))

    const { violations, warnings } = scanEpicRetroFreshness(root)
    expect(violations).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ epicNum: '7', value: 'abc', kind: 'malformed' })
  })

  it('5b. a negative counter value is also treated as malformed, not coerced to 0', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, sprintStatus(`  epic-7-retro-pending-closures: -1\n`))

    const { violations, warnings } = scanEpicRetroFreshness(root)
    expect(violations).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ epicNum: '7', value: '-1', kind: 'malformed' })
  })

  it('6. multiple epics simultaneously affected: each reported at its own correct severity', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      SPRINT_STATUS_PATH,
      sprintStatus(`  epic-7-retro-pending-closures: 1\n` + `  epic-12-retro-pending-closures: 2\n`)
    )

    const { violations, warnings } = scanEpicRetroFreshness(root)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ epicNum: '7', kind: 'pending-one' })
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ epicNum: '12', count: 2 })
  })

  it('7. real-repository regression run resolves clean (Epic 20 round-4 retro already done)', () => {
    const { violations, warnings } = scanEpicRetroFreshness(repositoryRoot)
    expect(violations).toEqual([])
    expect(warnings).toEqual([])
  })

  it('8. stale counter alongside a done retrospective still reports the violation', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      SPRINT_STATUS_PATH,
      sprintStatus(`  epic-9-retrospective: done\n  epic-9-retro-pending-closures: 2\n`)
    )

    const { violations } = scanEpicRetroFreshness(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ epicNum: '9', count: 2 })
  })

  it('9. key-name non-collision: epic-<N>-gate and a same-file pending-closures key are not confused', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      SPRINT_STATUS_PATH,
      sprintStatus(`  epic-51-gate: blocked-on-42-4\n` + `  epic-5-retro-pending-closures: 2\n`)
    )

    const { violations } = scanEpicRetroFreshness(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.epicNum).toBe('5')
  })

  it('no-ops cleanly when there are no epic-*-retro-pending-closures keys at all', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      SPRINT_STATUS_PATH,
      sprintStatus(`  epic-9: in-progress\n  9-1-fixture-story: done\n`)
    )

    expect(scanEpicRetroFreshness(root)).toEqual({ violations: [], warnings: [] })
  })

  it('fails open (empty result, no throw) when sprint-status.yaml is missing', () => {
    const root = makeFixtureRoot()
    expect(() => scanEpicRetroFreshness(root)).not.toThrow()
    expect(scanEpicRetroFreshness(root)).toEqual({ violations: [], warnings: [] })
  })
})

describe('check-epic-retro-freshness CLI', () => {
  it('exits non-zero and names the offending epic/count on a fixture with a violation', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, sprintStatus(`  epic-7-retro-pending-closures: 2\n`))

    let stderr = ''
    let threw = false
    try {
      execFileSync(process.execPath, ['--import', tsxLoaderPath, scriptPath], {
        cwd: root,
        stdio: 'pipe',
      })
    } catch (error) {
      threw = true
      stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? ''
    }
    expect(threw).toBe(true)
    expect(stderr).toContain('epic-7')
    expect(stderr).toContain('2')
    expect(stderr).toContain('my-epic-retro')
  })

  it('prints an informational WARN, exits zero, on a counter-at-1 fixture', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, sprintStatus(`  epic-7-retro-pending-closures: 1\n`))

    const stdout = execFileSync(process.execPath, ['--import', tsxLoaderPath, scriptPath], {
      cwd: root,
      stdio: 'pipe',
    }).toString()
    expect(stdout).toContain('WARN')
    expect(stdout).toContain('epic-7')
  })

  it('exits zero against the real repository state', () => {
    const stdout = execFileSync(process.execPath, ['--import', tsxLoaderPath, scriptPath], {
      cwd: repositoryRoot,
      stdio: 'pipe',
    }).toString()
    expect(stdout).toContain('check-epic-retro-freshness')
  })
})
