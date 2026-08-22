import { describe, expect, it } from 'vitest'
import { useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'
import { scanSprintStatusRollup } from './check-sprint-status-rollup.js'

const ARTIFACTS_DIR = '_bmad-output/implementation-artifacts'
const SPRINT_STATUS_PATH = `${ARTIFACTS_DIR}/sprint-status.yaml`

const makeFixtureRoot = useFixtureRoots('sprint-status-rollup-', [ARTIFACTS_DIR])

describe('scanSprintStatusRollup', () => {
  it('returns no drift when the epic rollup key is already done', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      SPRINT_STATUS_PATH,
      `development_status:
  epic-1: done
  1-1-first-story: done
  epic-1-retrospective: done
`
    )
    expect(scanSprintStatusRollup(root)).toEqual([])
  })

  it('returns no drift when an epic rollup is in-progress but its stories are not all done yet', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      SPRINT_STATUS_PATH,
      `development_status:
  epic-1: in-progress
  1-1-first-story: done
  1-2-second-story: review
  epic-1-retrospective: optional
`
    )
    expect(scanSprintStatusRollup(root)).toEqual([])
  })

  it('returns no drift when an epic has no stories yet (nothing to roll up)', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      SPRINT_STATUS_PATH,
      `development_status:
  epic-2: backlog
`
    )
    expect(scanSprintStatusRollup(root)).toEqual([])
  })

  it('returns no drift when all stories are done but the retrospective is not (epic not truly closed yet)', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      SPRINT_STATUS_PATH,
      `development_status:
  epic-16: in-progress
  16-1-install-and-compile-a-custom-theme: done
  16-2-select-an-active-theme: done
  epic-16-retrospective: optional
`
    )
    expect(scanSprintStatusRollup(root)).toEqual([])
  })

  it('flags an epic-N rollup key stuck non-done while all its stories + retrospective are done (epic-14/epic-15/epic-16 pattern)', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      SPRINT_STATUS_PATH,
      `development_status:
  epic-16: in-progress
  16-1-install-and-compile-a-custom-theme: done
  16-2-select-an-active-theme: done
  epic-16-retrospective: done
`
    )
    expect(scanSprintStatusRollup(root)).toEqual([
      {
        epicKey: 'epic-16',
        epicStatus: 'in-progress',
        childKeys: ['16-1-install-and-compile-a-custom-theme', '16-2-select-an-active-theme'],
      },
    ])
  })

  it('flags multiple drifted epics independently', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      SPRINT_STATUS_PATH,
      `development_status:
  epic-14: in-progress
  14-1-first-story: done
  epic-14-retrospective: done
  epic-15: review
  15-1-first-story: done
  epic-15-retrospective: done
`
    )
    const drifts = scanSprintStatusRollup(root)
    expect(drifts).toHaveLength(2)
    expect(drifts.map((d) => d.epicKey)).toEqual(['epic-14', 'epic-15'])
  })

  it('returns no drift when sprint-status.yaml does not exist', () => {
    const root = makeFixtureRoot()
    expect(scanSprintStatusRollup(root)).toEqual([])
  })
})

describe('scanSprintStatusRollup against the real repository', () => {
  it('passes with zero drift against the currently committed sprint-status.yaml', () => {
    expect(scanSprintStatusRollup(process.cwd())).toEqual([])
  })
})
