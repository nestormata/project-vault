import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  runScriptCli,
  useFixtureRoots,
  writeFixture,
  writeFixtureSymlink,
} from './lib/fixture-test-helpers.js'
import { scanSprintStatusRetroKeys, scanSprintStatusRollup } from './check-sprint-status-rollup.js'

const ARTIFACTS_DIR = '_bmad-output/implementation-artifacts'
const SPRINT_STATUS_PATH = `${ARTIFACTS_DIR}/sprint-status.yaml`
const IN_PROGRESS = 'in-progress'

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
        epicStatus: IN_PROGRESS,
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

  it('has no missing retrospective key and no duplicate key in the currently committed sprint-status.yaml (Story 43.11)', () => {
    const { missing, duplicates } = scanSprintStatusRetroKeys(process.cwd())
    expect(missing).toEqual([])
    expect(duplicates).toEqual([])
  })
})

const header = 'development_status:\n'
const writeSprint = (root: string, body: string) =>
  writeFixture(root, SPRINT_STATUS_PATH, header + body)

describe('scanSprintStatusRollup — widened child regex (Story 43.11 AC-1 edge case 5)', () => {
  it('a letter-suffixed child that is not done keeps the existing drift check quiet', () => {
    const root = makeFixtureRoot()
    writeSprint(
      root,
      '  epic-24: in-progress\n  24-1-a: done\n  24-5b-b: review\n  epic-24-retrospective: done\n'
    )
    expect(scanSprintStatusRollup(root)).toEqual([])
  })
})

describe('scanSprintStatusRetroKeys (Story 43.11 AC-1/AC-2)', () => {
  it('AC-1 positive: an epic with children but no retro key is a MissingRetrospectiveKey', () => {
    const root = makeFixtureRoot()
    writeSprint(
      root,
      '  epic-43: in-progress\n  43-1-fetch-a-secret: done\n  43-2-cli-login: done\n'
    )
    expect(scanSprintStatusRetroKeys(root)).toEqual({
      missing: [
        {
          epicKey: 'epic-43',
          epicStatus: IN_PROGRESS,
          line: 2,
          childKeys: ['43-1-fetch-a-secret', '43-2-cli-login'],
        },
      ],
      pending: [],
      duplicates: [],
    })
  })

  it.each([
    [
      'retro optional',
      '  epic-43: in-progress\n  43-1-a: review\n  epic-43-retrospective: optional\n',
    ],
    ['retro done, epic done', '  epic-43: done\n  43-1-a: done\n  epic-43-retrospective: done\n'],
    ['zero children, no retro key', '  epic-67: backlog\n'],
    ['zero children, with retro key', '  epic-67: backlog\n  epic-67-retrospective: optional\n'],
    ['orphan children without an epic key', '  70-1-x: backlog\n'],
    [
      'epic-51-gate key alongside epic-51',
      '  epic-51: in-progress\n  epic-51-gate: blocked-on-42-4\n  51-1-a: review\n  epic-51-retrospective: optional\n',
    ],
  ])('passes: %s', (_name, body) => {
    const root = makeFixtureRoot()
    writeSprint(root, body)
    expect(scanSprintStatusRetroKeys(root)).toEqual({ missing: [], pending: [], duplicates: [] })
  })

  it('edge 1: an epic already done with no retro key is still FATAL (not behind the done early-continue)', () => {
    const root = makeFixtureRoot()
    writeSprint(root, '  epic-44: done\n  44-1-x: done\n')
    expect(scanSprintStatusRetroKeys(root).missing.map((m) => m.epicKey)).toEqual(['epic-44'])
  })

  it('edge 2: an epic whose children are all backlog still needs its retro key', () => {
    const root = makeFixtureRoot()
    writeSprint(root, '  epic-66: backlog\n  66-1-x: backlog\n  66-2-y: backlog\n')
    expect(scanSprintStatusRetroKeys(root).missing).toMatchObject([
      { epicKey: 'epic-66', childKeys: ['66-1-x', '66-2-y'] },
    ])
  })

  it('edge 4: 51 vs 151 vs 5 child anchoring', () => {
    const root = makeFixtureRoot()
    writeSprint(
      root,
      '  epic-5: done\n  5-1-b: done\n  epic-5-retrospective: done\n' +
        '  epic-51: in-progress\n  51-1-a: done\n  epic-51-retrospective: optional\n' +
        '  epic-151: backlog\n'
    )
    expect(scanSprintStatusRetroKeys(root).missing).toEqual([])

    writeSprint(
      root,
      '  epic-51: in-progress\n  51-1-a: review\n  epic-51-retrospective: optional\n' +
        '  epic-151: backlog\n  151-1-c: backlog\n'
    )
    const { missing } = scanSprintStatusRetroKeys(root)
    expect(missing).toEqual([
      { epicKey: 'epic-151', epicStatus: 'backlog', line: 5, childKeys: ['151-1-c'] },
    ])
  })

  it('edge 5: a letter-suffixed story key is a child', () => {
    const root = makeFixtureRoot()
    writeSprint(root, '  epic-24: done\n  24-5b-public-sweep: done\n')
    expect(scanSprintStatusRetroKeys(root).missing).toMatchObject([
      { epicKey: 'epic-24', childKeys: ['24-5b-public-sweep'] },
    ])
  })

  it('edge 8: two epics missing keys are sorted numerically (epic-9 before epic-10)', () => {
    const root = makeFixtureRoot()
    writeSprint(
      root,
      '  epic-10: backlog\n  10-1-a: backlog\n  epic-9: backlog\n  9-1-a: backlog\n'
    )
    expect(scanSprintStatusRetroKeys(root).missing.map((m) => m.epicKey)).toEqual([
      'epic-9',
      'epic-10',
    ])
  })

  it('edge 9 + 12: interleaved column-0 comments and trailing value comments still parse', () => {
    const root = makeFixtureRoot()
    writeSprint(
      root,
      '  epic-43: in-progress # 7/7 done\n# last_updated: 2026-09-27 (x)\n  43-1-a: done\n'
    )
    expect(scanSprintStatusRetroKeys(root).missing).toEqual([
      { epicKey: 'epic-43', epicStatus: IN_PROGRESS, line: 2, childKeys: ['43-1-a'] },
    ])
  })

  it('edge 11: a duplicated development_status key is a DuplicateSprintStatusKey', () => {
    const root = makeFixtureRoot()
    writeSprint(
      root,
      '  epic-43: in-progress\n  43-1-a: review\n  epic-43-retrospective: optional\n' +
        '  43-1-a: review\n  epic-43-retrospective: done\n'
    )
    expect(scanSprintStatusRetroKeys(root).duplicates).toEqual([
      { key: '43-1-a', lines: [3, 5], values: ['review', 'review'] },
      { key: 'epic-43-retrospective', lines: [4, 6], values: ['optional', 'done'] },
    ])
  })

  it('AC-2 positive: every child done and the retro not done is a RetroPendingWarning', () => {
    const root = makeFixtureRoot()
    writeSprint(
      root,
      '  epic-60: in-progress\n  60-1-a: done\n  60-2-b: done\n  epic-60-retrospective: optional\n'
    )
    expect(scanSprintStatusRetroKeys(root)).toEqual({
      missing: [],
      pending: [
        {
          epicKey: 'epic-60',
          retroStatus: 'optional',
          line: 5,
          childKeys: ['60-1-a', '60-2-b'],
        },
      ],
      duplicates: [],
    })
  })

  it('AC-2 edges: one child in review, a done retro, or a missing retro key never warn', () => {
    const root = makeFixtureRoot()
    writeSprint(
      root,
      '  epic-60: in-progress\n  60-1-a: done\n  60-2-b: review\n  epic-60-retrospective: optional\n'
    )
    expect(scanSprintStatusRetroKeys(root).pending).toEqual([])

    writeSprint(root, '  epic-60: in-progress\n  60-1-a: done\n  epic-60-retrospective: done\n')
    expect(scanSprintStatusRetroKeys(root).pending).toEqual([])
    expect(scanSprintStatusRollup(root)).toHaveLength(1)

    writeSprint(root, '  epic-60: in-progress\n  60-1-a: done\n')
    expect(scanSprintStatusRetroKeys(root).pending).toEqual([])
    expect(scanSprintStatusRetroKeys(root).missing).toHaveLength(1)
  })

  it('AC-2 edges: a retro in-progress, or an epic done with an optional retro, warns', () => {
    const root = makeFixtureRoot()
    writeSprint(
      root,
      '  epic-60: in-progress\n  60-1-a: done\n  epic-60-retrospective: in-progress\n'
    )
    expect(scanSprintStatusRetroKeys(root).pending).toMatchObject([{ retroStatus: 'in-progress' }])

    writeSprint(root, '  epic-60: done\n  60-1-a: done\n  epic-60-retrospective: optional\n')
    expect(scanSprintStatusRetroKeys(root).pending).toMatchObject([{ epicKey: 'epic-60' }])
  })

  it('returns empty findings when sprint-status.yaml is absent', () => {
    const root = makeFixtureRoot()
    expect(scanSprintStatusRetroKeys(root)).toEqual({ missing: [], pending: [], duplicates: [] })
  })
})

describe('check-sprint-status-rollup CLI (Story 43.11 AC-1/AC-2/AC-7)', () => {
  const SCRIPT = 'scripts/check-sprint-status-rollup.ts'

  it('AC-1: prints the MissingRetrospectiveKey FATAL block with path:line and a Fix line, exit 1', () => {
    const root = makeFixtureRoot()
    writeSprint(
      root,
      '  epic-43: in-progress\n  43-1-fetch-a-secret: done\n  43-2-cli-login: done\n'
    )
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(1)
    expect(run.stderr).toContain(
      'FATAL: epic-N has child stories but no epic-N-retrospective key (epic-43 retro Finding 4):\n' +
        `  - ${SPRINT_STATUS_PATH}:2: epic-43 (in-progress) has 2 child stories (43-1-fetch-a-secret, 43-2-cli-login) but no epic-43-retrospective key\n` +
        "\nFix: add `  epic-43-retrospective: optional` under the epic's stories in sprint-status.yaml (use `done` only if the retro has actually run).\n"
    )
    expect(run.stdout).not.toContain('OK')
  })

  it('AC-1 edge 4 mirror: the message for epic-151 never mentions epic-51', () => {
    const root = makeFixtureRoot()
    writeSprint(
      root,
      '  epic-51: in-progress\n  51-1-a: review\n  epic-51-retrospective: optional\n  epic-151: backlog\n  151-1-c: backlog\n'
    )
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('epic-151')
    expect(run.stderr).not.toMatch(/\bepic-51\b/)
  })

  it('AC-1 edge 11: prints the DuplicateSprintStatusKey FATAL line', () => {
    const root = makeFixtureRoot()
    writeSprint(
      root,
      '  epic-43: in-progress\n  43-1-a: review\n  epic-43-retrospective: optional\n  epic-43-retrospective: done\n'
    )
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(1)
    expect(run.stderr).toContain(
      `  - ${SPRINT_STATUS_PATH}:4 and :5: key "epic-43-retrospective" is declared twice ("optional", "done")\n`
    )
  })

  it('AC-2: WARN goes to stderr, exit 0, and the OK line still prints', () => {
    const root = makeFixtureRoot()
    writeSprint(
      root,
      '  epic-60: in-progress\n  60-1-a: done\n  60-2-b: done\n  epic-60-retrospective: optional\n'
    )
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(0)
    expect(run.stderr).toContain(
      'WARN: every story of epic-60 is done but its retrospective is not (retro due):\n' +
        `  - ${SPRINT_STATUS_PATH}:5: epic-60-retrospective is "optional" (children: 60-1-a, 60-2-b)\n`
    )
    expect(run.stdout).toContain('— OK')
  })

  it('AC-2 edge 5: WARN plus FATAL prints the FATAL block first and exits 1', () => {
    const root = makeFixtureRoot()
    writeSprint(
      root,
      '  epic-60: in-progress\n  60-1-a: done\n  epic-60-retrospective: optional\n' +
        '  epic-61: in-progress\n  61-1-a: review\n'
    )
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(1)
    expect(run.stderr.indexOf('FATAL:')).toBeGreaterThan(-1)
    expect(run.stderr.indexOf('FATAL:')).toBeLessThan(run.stderr.indexOf('WARN:'))
    expect(run.stdout).not.toContain('OK')
  })

  it('AC-2 edge 2: a done retro with a non-done epic stays the existing drift FATAL, not a WARN', () => {
    const root = makeFixtureRoot()
    writeSprint(root, '  epic-60: in-progress\n  60-1-a: done\n  epic-60-retrospective: done\n')
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('FATAL: epic-N rollup key is stuck non-done')
    expect(run.stderr).not.toContain('WARN:')
  })

  it('AC-7: prints SKIPPED (never OK) when sprint-status.yaml is absent or a dangling symlink', () => {
    const absent = makeFixtureRoot()
    const run = runScriptCli(SCRIPT, absent)
    expect(run.status).toBe(0)
    expect(run.stdout).toContain(
      `check-sprint-status-rollup: SKIPPED — ${SPRINT_STATUS_PATH} not found (private overlay not attached); nothing checked`
    )
    expect(run.stdout).not.toContain('— OK')

    const dangling = makeFixtureRoot()
    writeFixtureSymlink(dangling, SPRINT_STATUS_PATH, '/nonexistent/private/sprint-status.yaml')
    const danglingRun = runScriptCli(SCRIPT, dangling)
    expect(danglingRun.status).toBe(0)
    expect(danglingRun.stdout).toContain('SKIPPED')
    expect(danglingRun.stdout).toContain('dangling')
  })

  it('code review: FATAL (never OK) when sprint-status.yaml exists but cannot be read as a file', () => {
    const root = makeFixtureRoot()
    mkdirSync(join(root, SPRINT_STATUS_PATH), { recursive: true })
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(1)
    expect(run.stderr).toContain(
      `FATAL: check-sprint-status-rollup: ${SPRINT_STATUS_PATH} cannot be read`
    )
    expect(run.stdout).not.toContain('OK')
  })

  it('AC-7.3: a present file without a development_status block is not a skip', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, 'generated: x\n')
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('— OK')
  })
})
