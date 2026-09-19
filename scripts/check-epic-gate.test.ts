import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'
import { scanEpicGate } from './check-epic-gate.js'

const ARTIFACTS_DIR = '_bmad-output/implementation-artifacts'
const SPRINT_STATUS_PATH = `${ARTIFACTS_DIR}/sprint-status.yaml`

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const makeFixtureRoot = useFixtureRoots('epic-gate-', [ARTIFACTS_DIR])

const GATE_KEY = 'epic-51-gate'
const GATE_VALUE = 'blocked-on-42-4'
const GATED_STORY_KEY = '51-1-fixture-story'
const BLOCKING_STORY_KEY = '42-4-fixture-story'

const sprintStatus = (developmentStatusBlock: string) =>
  `generated: 2026-05-31
last_updated: 2026-09-19
project: Fixture Project

development_status:
${developmentStatusBlock}`

describe('scanEpicGate', () => {
  it('reports a violation: unsatisfied gate + a gated story advanced past backlog', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      SPRINT_STATUS_PATH,
      sprintStatus(
        `  ${GATE_KEY}: ${GATE_VALUE}\n` +
          `  ${GATED_STORY_KEY}: in-progress\n` +
          `  ${BLOCKING_STORY_KEY}: backlog\n`
      )
    )

    const { violations, warnings } = scanEpicGate(root)
    expect(warnings).toEqual([])
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({
      storyKey: GATED_STORY_KEY,
      storyStatus: 'in-progress',
      gateKey: GATE_KEY,
      blockingStoryKey: BLOCKING_STORY_KEY,
      blockingStatus: 'backlog',
    })
  })

  it('passes clean: unsatisfied gate but every gated story is still backlog (AC1: creation was never gated)', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      SPRINT_STATUS_PATH,
      sprintStatus(
        `  ${GATE_KEY}: ${GATE_VALUE}\n` +
          `  ${GATED_STORY_KEY}: backlog\n` +
          `  ${BLOCKING_STORY_KEY}: backlog\n`
      )
    )

    const { violations, warnings } = scanEpicGate(root)
    expect(violations).toEqual([])
    expect(warnings).toEqual([])
  })

  it('passes clean: satisfied gate (blocking story done) even with an advanced gated story', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      SPRINT_STATUS_PATH,
      sprintStatus(
        `  ${GATE_KEY}: ${GATE_VALUE}\n` +
          `  ${GATED_STORY_KEY}: in-progress\n` +
          `  ${BLOCKING_STORY_KEY}: done\n`
      )
    )

    const { violations, warnings } = scanEpicGate(root)
    expect(violations).toEqual([])
    expect(warnings).toEqual([])
  })

  it('does not trust an epic rollup status as a shortcut for the named blocking story (AC5)', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      SPRINT_STATUS_PATH,
      sprintStatus(
        `  epic-42: done\n` +
          `  ${GATE_KEY}: ${GATE_VALUE}\n` +
          `  ${GATED_STORY_KEY}: in-progress\n` +
          `  ${BLOCKING_STORY_KEY}: backlog\n`
      )
    )

    const { violations } = scanEpicGate(root)
    expect(violations).toHaveLength(1)
    expect(violations[0]?.blockingStatus).toBe('backlog')
  })

  it('warns (does not fail) on a malformed gate value that does not parse as blocked-on-<epic>-<story>', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      SPRINT_STATUS_PATH,
      sprintStatus(`  ${GATE_KEY}: satisfied\n` + `  ${GATED_STORY_KEY}: in-progress\n`)
    )

    const { violations, warnings } = scanEpicGate(root)
    expect(violations).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatchObject({ gateKey: GATE_KEY, value: 'satisfied' })
  })

  it('warns (does not fail) when the gate value names a blocking story key with no matching development_status entry', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      SPRINT_STATUS_PATH,
      sprintStatus(
        `  ${GATE_KEY}: blocked-on-42-9\n` + // 42-9 never registered
          `  ${GATED_STORY_KEY}: in-progress\n`
      )
    )

    const { violations, warnings } = scanEpicGate(root)
    expect(violations).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.gateKey).toBe(GATE_KEY)
  })

  it('no-ops cleanly when there are no epic-*-gate keys at all', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      SPRINT_STATUS_PATH,
      sprintStatus(`  epic-9: in-progress\n  9-1-fixture-story: done\n`)
    )

    expect(scanEpicGate(root)).toEqual({ violations: [], warnings: [] })
  })

  it('never blocks the blocking story from being picked up by its own gate (edge case)', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      SPRINT_STATUS_PATH,
      sprintStatus(
        `  ${GATE_KEY}: ${GATE_VALUE}\n` + `  ${BLOCKING_STORY_KEY}: in-progress\n` // the blocking story itself, not a 51-* key
      )
    )

    const { violations } = scanEpicGate(root)
    expect(violations).toEqual([])
  })

  it('never false-positives on a substring epic-number match (e.g. 151-* vs gated epic 51)', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      SPRINT_STATUS_PATH,
      sprintStatus(
        `  ${GATE_KEY}: ${GATE_VALUE}\n` +
          `  151-1-fixture-story: in-progress\n` + // must NOT be treated as belonging to epic 51
          `  ${BLOCKING_STORY_KEY}: backlog\n`
      )
    )

    const { violations } = scanEpicGate(root)
    expect(violations).toEqual([])
  })

  it('fails open (empty result, no throw) when sprint-status.yaml is missing', () => {
    const root = makeFixtureRoot()
    expect(() => scanEpicGate(root)).not.toThrow()
    expect(scanEpicGate(root)).toEqual({ violations: [], warnings: [] })
  })

  it('the real repository state passes cleanly today (42-4 is backlog, no 51-* story has advanced)', () => {
    const { violations } = scanEpicGate(repositoryRoot)
    expect(violations).toEqual([])
  })
})

describe('check-epic-gate CLI', () => {
  it('exits non-zero and names the offending story/gate on a fixture with a violation', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      SPRINT_STATUS_PATH,
      sprintStatus(
        `  ${GATE_KEY}: ${GATE_VALUE}\n` +
          `  ${GATED_STORY_KEY}: in-progress\n` +
          `  ${BLOCKING_STORY_KEY}: backlog\n`
      )
    )

    const script = resolve(repositoryRoot, 'scripts/check-epic-gate.ts')
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
    expect(stderr).toContain(GATED_STORY_KEY)
    expect(stderr).toContain(GATE_KEY)
  })

  it('exits zero against the real repository state', () => {
    const script = resolve(repositoryRoot, 'scripts/check-epic-gate.ts')
    const tsxLoader = resolve(repositoryRoot, 'node_modules/tsx/dist/esm/index.mjs')

    const stdout = execFileSync(process.execPath, ['--import', tsxLoader, script], {
      cwd: repositoryRoot,
      stdio: 'pipe',
    }).toString()
    expect(stdout).toContain('check-epic-gate')
  })
})
