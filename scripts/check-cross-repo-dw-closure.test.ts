import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'
import { resolveCmPath, scanCrossRepoDwClosure } from './check-cross-repo-dw-closure.js'

const ARTIFACTS_DIR = '_bmad-output/implementation-artifacts'
const SPRINT_STATUS_PATH = `${ARTIFACTS_DIR}/sprint-status.yaml`
const CM_DW_RELATIVE_PATH = 'cm/deferred-work.md'

const makeFixtureRoot = useFixtureRoots('cross-repo-dw-closure-', [ARTIFACTS_DIR])

const DONE_STORY_KEY = '20-12-pv-add-a-hostservices-credential-sharing-facade-hook'
const NOT_DONE_STORY_KEY =
  '20-13-pv-anonymous-share-redemption-route-and-list-shares-host-services-methods'

const sprintStatus = (developmentStatusBlock: string) =>
  `generated: 2026-05-31
last_updated: 2026-09-21
project: Fixture Project

development_status:
${developmentStatusBlock}`

const DEFAULT_SPRINT_STATUS = sprintStatus(
  `  ${DONE_STORY_KEY}: done\n` + `  ${NOT_DONE_STORY_KEY}: in-progress\n`
)

function writeSprintStatus(root: string, block: string = DEFAULT_SPRINT_STATUS): void {
  writeFixture(root, SPRINT_STATUS_PATH, block)
}

/** Writes the fixture `deferred-work.md` and returns its resolved path for `scanCrossRepoDwClosure`. */
function writeCmDeferredWork(root: string, content: string): string {
  writeFixture(root, CM_DW_RELATIVE_PATH, content)
  return resolve(root, CM_DW_RELATIVE_PATH)
}

function dwEntry(dwNumber: string, status: string, body: string): string {
  return `### DW-${dwNumber}: fixture entry\n\n${body}\nstatus: ${status}\n\n`
}

describe('scanCrossRepoDwClosure', () => {
  it('fails open (skip message, no warnings) when the sibling deferred-work.md is missing', () => {
    const root = makeFixtureRoot()
    writeSprintStatus(root)
    const missingPath = resolve(root, 'nowhere/deferred-work.md')

    const result = scanCrossRepoDwClosure(root, missingPath)
    expect(result.skipped).toBe(true)
    expect(result.skipMessage).toContain(missingPath)
    expect(result.warnings).toEqual([])
  })

  it('produces zero warnings when no entry names a done PV story key', () => {
    const root = makeFixtureRoot()
    writeSprintStatus(root)
    const cmPath = writeCmDeferredWork(
      root,
      dwEntry('100', 'open', 'This entry is about something entirely unrelated.')
    )

    const result = scanCrossRepoDwClosure(root, cmPath)
    expect(result.skipped).toBe(false)
    expect(result.warnings).toEqual([])
  })

  it('produces zero warnings for a done PV story named in an entry whose status is done/closed/resolved/superseded', () => {
    const root = makeFixtureRoot()
    writeSprintStatus(root)
    const content =
      dwEntry('201', 'done', `names PV story ${DONE_STORY_KEY} as its blocker.`) +
      dwEntry('202', 'closed', `names PV story ${DONE_STORY_KEY} as its blocker.`) +
      dwEntry('203', 'resolved', `names PV story ${DONE_STORY_KEY} as its blocker.`) +
      dwEntry('204', 'superseded', `names PV story ${DONE_STORY_KEY} as its blocker.`)
    const cmPath = writeCmDeferredWork(root, content)

    const result = scanCrossRepoDwClosure(root, cmPath)
    expect(result.warnings).toEqual([])
  })

  it('warns on a stale-open match: entry names a done PV story and status: open', () => {
    const root = makeFixtureRoot()
    writeSprintStatus(root)
    const cmPath = writeCmDeferredWork(
      root,
      dwEntry('198', 'open', `names PV story ${DONE_STORY_KEY} as its blocker.`)
    )

    const result = scanCrossRepoDwClosure(root, cmPath)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatchObject({
      dwNumber: '198',
      storyKey: DONE_STORY_KEY,
      statusToken: 'open',
    })
  })

  it('warns on status: narrowed naming a done PV story (deliberate exception, not grouped with resolved)', () => {
    const root = makeFixtureRoot()
    writeSprintStatus(root)
    const cmPath = writeCmDeferredWork(
      root,
      dwEntry('205', 'narrowed', `names PV story ${DONE_STORY_KEY} as its blocker.`)
    )

    const result = scanCrossRepoDwClosure(root, cmPath)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatchObject({
      dwNumber: '205',
      storyKey: DONE_STORY_KEY,
      statusToken: 'narrowed',
    })
  })

  it('produces no warning when the named PV story is not yet done, regardless of the entry status', () => {
    const root = makeFixtureRoot()
    writeSprintStatus(root)
    const cmPath = writeCmDeferredWork(
      root,
      dwEntry('206', 'open', `names PV story ${NOT_DONE_STORY_KEY} as its blocker.`)
    )

    const result = scanCrossRepoDwClosure(root, cmPath)
    expect(result.warnings).toEqual([])
  })

  it('reports exactly two warnings for a file with one resolved, one stale-open, one narrowed, one not-yet-done entry', () => {
    const root = makeFixtureRoot()
    writeSprintStatus(root)
    const content =
      dwEntry('301', 'closed', `resolved match naming ${DONE_STORY_KEY}.`) +
      dwEntry('302', 'open', `stale-open match naming ${DONE_STORY_KEY}.`) +
      dwEntry('303', 'narrowed', `narrowed match naming ${DONE_STORY_KEY}.`) +
      dwEntry('304', 'open', `not-yet-done match naming ${NOT_DONE_STORY_KEY}.`)
    const cmPath = writeCmDeferredWork(root, content)

    const result = scanCrossRepoDwClosure(root, cmPath)
    expect(result.warnings).toHaveLength(2)
    expect(result.warnings.map((w) => w.dwNumber).sort()).toEqual(['302', '303'])
  })

  it('treats a missing or unrecognized status: field as NOT RESOLVED and notes it was unparseable, not blank/fabricated', () => {
    const root = makeFixtureRoot()
    writeSprintStatus(root)
    const content =
      `### DW-401: fixture entry with no status line at all\n\n` +
      `names PV story ${DONE_STORY_KEY} as its blocker.\n\n` +
      dwEntry(
        '402',
        'pending',
        `names PV story ${DONE_STORY_KEY} as its blocker (unrecognized token).`
      )
    const cmPath = writeCmDeferredWork(root, content)

    const result = scanCrossRepoDwClosure(root, cmPath)
    expect(result.warnings).toHaveLength(2)
    const missing = result.warnings.find((w) => w.dwNumber === '401')
    const unrecognized = result.warnings.find((w) => w.dwNumber === '402')
    expect(missing?.statusToken).toBeUndefined()
    expect(unrecognized?.statusToken).toBe('pending')
  })

  it('resolves the CLI flag over the env var over the default guess (precedence)', () => {
    const root = makeFixtureRoot()
    const cliPath = resolve(root, 'cli/deferred-work.md')
    const envPath = resolve(root, 'env/deferred-work.md')

    const originalEnv = process.env.CENTRALIZEME_SASS_PATH
    process.env.CENTRALIZEME_SASS_PATH = envPath
    try {
      expect(resolveCmPath(root, cliPath)).toBe(resolve(cliPath))
      expect(resolveCmPath(root)).toBe(resolve(envPath))
    } finally {
      if (originalEnv === undefined) delete process.env.CENTRALIZEME_SASS_PATH
      else process.env.CENTRALIZEME_SASS_PATH = originalEnv
    }

    delete process.env.CENTRALIZEME_SASS_PATH
    expect(resolveCmPath(root)).toBe(
      resolve(root, '../centralizeme-sass/_bmad-output/implementation-artifacts/deferred-work.md')
    )
  })
})

// The real-repository regression run (AC-3 scenario 10) is deliberately NOT a Vitest test here —
// it depends on this specific machine's local centralizeme-sass checkout existing, and is instead
// run manually and its actual output recorded in this story's Dev Agent Record (see
// 20-15-cross-repo-dw-closure-verification-check.md).
