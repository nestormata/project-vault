import { describe, expect, it } from 'vitest'
import {
  findUnrunPhrase,
  loadBaseline,
  scanUnrunCheckDestinations,
} from './check-unrun-check-destinations.js'
import {
  runScriptCli,
  useFixtureRoots,
  writeFixture,
  writeFixtureDir,
  writeFixtureSymlink,
} from './lib/fixture-test-helpers.js'

const ARTIFACTS_DIR = '_bmad-output/implementation-artifacts'
const SPRINT_PATH = `${ARTIFACTS_DIR}/sprint-status.yaml`
const LEDGER_PATH = `${ARTIFACTS_DIR}/deferred-work.md`
const SCRIPT = 'scripts/check-unrun-check-destinations.ts'
const KEY = '69-15-verify-region-split'
const STORY_PATH = `${ARTIFACTS_DIR}/${KEY}.md`
const HUMAN_KEY = '69-16-human-manual-testing'
const LEDGER =
  '# Deferred work\n\n### DW-613 copy call\n\nstatus: open — Trigger to revisit: 63-1.\n'
const ZOOM = 'Not run: zoom.'
const NO_BASELINE = new Map<string, number>()

const makeFixtureRoot = useFixtureRoots('unrun-check-destinations-', [ARTIFACTS_DIR])

type Fixture = {
  statuses?: string[]
  stories?: Record<string, string>
  files?: Record<string, string>
  ledger?: string
}

function fixture({
  statuses = [`${KEY}: done`, `${HUMAN_KEY}: backlog`],
  stories = {},
  files = {},
  ledger = LEDGER,
}: Fixture): string {
  const root = makeFixtureRoot()
  writeFixture(
    root,
    SPRINT_PATH,
    `development_status:\n${statuses.map((s) => `  ${s}\n`).join('')}`
  )
  writeFixture(root, LEDGER_PATH, ledger)
  for (const [name, content] of Object.entries(stories)) {
    writeFixture(root, `${ARTIFACTS_DIR}/${name}`, content)
  }
  for (const [path, content] of Object.entries(files)) writeFixture(root, path, content)
  return root
}

function story(body: string): string {
  return `# Story 69.15\n\nStatus: done\n\n## Story\n\nAs a reviewer\n\n## Chrome pass\n\n${body}\n`
}

const scan = (f: Fixture, baseline: ReadonlyMap<string, number> = NO_BASELINE) =>
  scanUnrunCheckDestinations(fixture(f), baseline)

const messages = (f: Fixture, baseline?: ReadonlyMap<string, number>) =>
  scan(f, baseline).violations.map((v) => v.message)

const oneStory = (body: string, extra: Partial<Fixture> = {}) =>
  messages({ stories: { [`${KEY}.md`]: story(body) }, ...extra })

describe('findUnrunPhrase (AC-1 phrase set)', () => {
  it.each([
    ['- Not run (extension cannot): 390 px, 200 % zoom.', 'Not run'],
    ['NOT RUN: members role change (one user only)', 'NOT RUN'],
    ['Not drivable: 390 px, keyboard-only', 'Not drivable'],
    ['the diff was not executed in this session', 'not executed'],
    ['EN novel page text was not captured', 'not captured'],
    ['we could not run the composed host', 'could not run'],
    ['and could not drive the file dialog', 'could not drive'],
    ['the extension cannot resize the window', 'extension cannot'],
  ])('detects %s', (line, phrase) => {
    expect(findUnrunPhrase(line)).toBe(phrase)
  })

  it.each([
    'the vault_app role cannot run an ad-hoc DELETE',
    'every check ran green',
    'notrun is a variable name',
    'it could not runtime-load the module',
  ])('does not detect %s', (line) => {
    expect(findUnrunPhrase(line)).toBeUndefined()
  })
})

describe('scanUnrunCheckDestinations: detection scope (AC-1)', () => {
  it('fails an unrun line with no destination, naming path:line and the phrase', () => {
    const { violations } = scan({ stories: { [`${KEY}.md`]: story('- Not run: 390 px.') } })
    expect(violations).toEqual([
      {
        kind: 'no-destination',
        path: STORY_PATH,
        line: 11,
        message: `${KEY}: "Not run" names no destination`,
      },
    ])
  })

  it('skips the ## Story section and fenced code', () => {
    const content =
      '# Story\n\nStatus: done\n\n## Story\n\nso that I am not run over by a release\n\n' +
      "## Dev Notes\n\n```bash\ngrep -n 'not run' story.md\n```\n"
    expect(messages({ stories: { [`${KEY}.md`]: content } })).toEqual([])
  })

  it('scans a section after ## Story again (the skip ends at the next heading)', () => {
    const content = '## Story\n\nAs a user\n\n### Chrome\n\nNot run: zoom.\n'
    expect(messages({ stories: { [`${KEY}.md`]: content } })).toHaveLength(1)
  })

  it('scans only done stories', () => {
    const f = {
      statuses: [`${KEY}: review`, `${HUMAN_KEY}: backlog`],
      stories: { [`${KEY}.md`]: story(ZOOM) },
    }
    expect(messages(f)).toEqual([])
  })

  it('reads a spec-<key>.md story file and a letter-suffixed key', () => {
    const key = '24-5b-themes'
    const f = {
      statuses: [`${key}: done`],
      stories: { [`spec-${key}.md`]: story(ZOOM) },
    }
    expect(scan(f).violations[0]?.path).toBe(`${ARTIFACTS_DIR}/spec-${key}.md`)
  })

  it('handles CRLF line endings', () => {
    const content = story('Not run: zoom; moved to backlog story 69-16-human-manual-testing.')
    expect(messages({ stories: { [`${KEY}.md`]: content.replaceAll('\n', '\r\n') } })).toEqual([])
  })
})

describe('scanUnrunCheckDestinations: destinations (AC-2)', () => {
  it('accepts a registered full backlog key, a DW entry and an existing covering file', () => {
    const body = [
      `- Not run (extension cannot): 390 px; moved to backlog story ${HUMAN_KEY}.`,
      '- EN text not captured; ledgered as DW-613.',
      '- Not run in Chrome; covered by `apps/web/src/lib/notice.test.ts:12`.',
      `- Not executed here; covered by ${HUMAN_KEY}.`,
    ].join('\n')
    expect(oneStory(body, { files: { 'apps/web/src/lib/notice.test.ts': 'test' } })).toEqual([])
  })

  it('is case-insensitive on the destination phrase', () => {
    expect(oneStory(`NOT RUN: zoom. Moved to backlog story ${HUMAN_KEY}`)).toEqual([])
  })

  it('rejects a short story id (the 63-3 "Moved to story 69-16" miss)', () => {
    expect(oneStory('Not run: zoom; moved to backlog story 69-16.')).toEqual([
      `${KEY}: "Not run" names no destination; moved to backlog story "69-16" is not a full story key`,
    ])
  })

  it('rejects a token that only starts with a registered key', () => {
    expect(oneStory(`Not run; moved to backlog story ${HUMAN_KEY}/notes.md`)).toEqual([
      `${KEY}: "Not run" names no destination; moved to backlog story "${HUMAN_KEY}/notes.md" is not a full story key`,
    ])
  })

  it('rejects an unregistered key, a missing DW entry and the story itself', () => {
    expect(oneStory('Not run; moved to backlog story 99-1-ghost-story.')).toEqual([
      `${KEY}: "Not run" names no destination; 99-1-ghost-story is not in sprint-status.yaml`,
    ])
    expect(oneStory('Not run; ledgered as DW-9999.')).toEqual([
      `${KEY}: "Not run" names no destination; DW-9999 is not in deferred-work.md`,
    ])
    expect(oneStory(`Not run; moved to backlog story ${KEY}.`)).toEqual([
      `${KEY}: "Not run" names no destination; ${KEY} is the story itself`,
    ])
  })

  it('rejects "covered by" prose, a missing file and a directory', () => {
    expect(oneStory('Not run; covered by unit tests.')).toEqual([
      `${KEY}: "Not run" names no destination; covered by "unit" is neither a registered story key nor an existing file`,
    ])
    expect(oneStory('Not run; covered by `apps/web/gone.test.ts`.')).toEqual([
      `${KEY}: "Not run" names no destination; covered by "apps/web/gone.test.ts" is neither a registered story key nor an existing file`,
    ])
    expect(oneStory('Not run; covered by `apps/web`.', { files: { 'apps/web/x.ts': '' } })).toEqual(
      [
        `${KEY}: "Not run" names no destination; covered by "apps/web" is neither a registered story key nor an existing file`,
      ]
    )
  })

  it('passes when one of several destinations resolves', () => {
    expect(oneStory(`Not run; ledgered as DW-9999, moved to backlog story ${HUMAN_KEY}.`)).toEqual(
      []
    )
  })

  it('requires the destination on the same line as the hit', () => {
    expect(oneStory(`Not run: zoom.\nmoved to backlog story ${HUMAN_KEY}`)).toHaveLength(1)
  })
})

describe('scanUnrunCheckDestinations: grandfathered baseline (AC-3)', () => {
  const twoHits = { stories: { [`${KEY}.md`]: story('Not run: zoom.\nNot run: 390 px.') } }

  it('skips a baselined story whose unresolved count equals the baseline', () => {
    const findings = scan(twoHits, new Map([['69-15', 2]]))
    expect(findings.violations).toEqual([])
    expect(findings.grandfathered).toBe(1)
  })

  it('fails a baselined story that gained an unresolved line, listing every line', () => {
    const findings = scan(twoHits, new Map([['69-15', 1]]))
    expect(findings.violations.map((v) => [v.kind, v.line])).toEqual([
      ['over-baseline', 11],
      ['over-baseline', 12],
    ])
    expect(findings.violations[0]?.message).toBe(
      `${KEY}: "Not run" names no destination (2 unresolved lines, the 2026-10-24 baseline allows 1)`
    )
  })

  it('fails a baselined story that now has fewer unresolved lines (the ratchet only shrinks)', () => {
    expect(messages(twoHits, new Map([['69-15', 3]]))).toEqual([
      `69-15: 2 unresolved lines, but unrun-check-baseline.json allows 3; lower it to 2`,
    ])
    const clean = {
      stories: { [`${KEY}.md`]: story(`Not run; moved to backlog story ${HUMAN_KEY}`) },
    }
    expect(messages(clean, new Map([['69-15', 1]]))).toEqual([
      `69-15: 0 unresolved lines, but unrun-check-baseline.json allows 1; remove the entry`,
    ])
  })

  it('fails a baseline entry with no done story file of that number', () => {
    expect(messages({ stories: {} }, new Map([['5-99', 1]]))).toEqual([
      '5-99: in unrun-check-baseline.json but no done story file has that number; remove the entry',
    ])
  })

  it('the shipped baseline only holds positive counts for well-formed story numbers', () => {
    const shipped = loadBaseline(process.cwd())
    expect(shipped.size).toBeGreaterThan(0)
    for (const [storyNumber, count] of shipped) {
      expect(storyNumber).toMatch(/^\d+-\d+[a-z]?$/)
      expect(Number.isInteger(count) && count > 0, storyNumber).toBe(true)
    }
  })
})

describe('check-unrun-check-destinations CLI (AC-4)', () => {
  it('prints the OK line with counts, exit 0', () => {
    const root = fixture({
      stories: { [`${KEY}.md`]: story(`Not run; moved to backlog story ${HUMAN_KEY}.`) },
    })
    const run = runScriptCli(SCRIPT, root)
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(run.stdout).toMatch(
      /^check-unrun-check-destinations: 1 done stories scanned, 1 unrun-check lines with destinations, 0 grandfathered — OK\n$/
    )
  })

  it('prints a FATAL block with path:line and a Fix line, exit 1', () => {
    const root = fixture({ stories: { [`${KEY}.md`]: story(ZOOM) } })
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(1)
    expect(run.stderr).toContain(
      'FATAL: done stories record a check that was not run without naming where it went ' +
        '(epic-63 retro Finding 1):'
    )
    expect(run.stderr).toContain(`  - ${STORY_PATH}:11: ${KEY}: "Not run" names no destination`)
    expect(run.stderr).toContain('Fix: on the same line, write `moved to backlog story <full key>`')
    expect(run.stdout).not.toContain('OK')
  })

  it('reads the baseline from the scanned root: matching counts pass, a stale entry fails', () => {
    const stories = { [`${KEY}.md`]: story(ZOOM) }
    const matching = fixture({
      stories,
      files: { 'scripts/unrun-check-baseline.json': '{"69-15": 1}' },
    })
    const okRun = runScriptCli(SCRIPT, matching)
    expect(okRun.status).toBe(0)
    expect(okRun.stdout).toContain('1 grandfathered — OK')

    const stale = fixture({
      stories,
      files: { 'scripts/unrun-check-baseline.json': '{"69-15": 1, "5-99": 2}' },
    })
    const staleRun = runScriptCli(SCRIPT, stale)
    expect(staleRun.status).toBe(1)
    expect(staleRun.stderr).toContain(
      '  - scripts/unrun-check-baseline.json:1: 5-99: in unrun-check-baseline.json but no done story file has that number; remove the entry'
    )
  })

  it('prints SKIPPED (never OK) when an overlay input is absent or a dangling symlink', () => {
    const absent = makeFixtureRoot()
    const run = runScriptCli(SCRIPT, absent)
    expect(run.status).toBe(0)
    expect(run.stdout).toContain(
      `check-unrun-check-destinations: SKIPPED — ${SPRINT_PATH} not found (private overlay not attached); nothing checked`
    )
    expect(run.stdout).not.toContain('— OK')

    const noLedger = makeFixtureRoot()
    writeFixture(noLedger, SPRINT_PATH, 'development_status:\n')
    writeFixtureSymlink(noLedger, LEDGER_PATH, '/nonexistent/deferred-work.md')
    const danglingRun = runScriptCli(SCRIPT, noLedger)
    expect(danglingRun.status).toBe(0)
    expect(danglingRun.stdout).toContain('SKIPPED')
    expect(danglingRun.stdout).toContain('dangling')
  })

  it('FATAL (never OK) when sprint-status.yaml is a directory or truncated', () => {
    const dir = makeFixtureRoot()
    writeFixtureDir(dir, SPRINT_PATH)
    const dirRun = runScriptCli(SCRIPT, dir)
    expect(dirRun.status).toBe(1)
    expect(dirRun.stderr).toContain(`${SPRINT_PATH} cannot be read`)

    const truncated = makeFixtureRoot()
    writeFixture(truncated, SPRINT_PATH, 'generated: x\n')
    writeFixture(truncated, LEDGER_PATH, LEDGER)
    const truncatedRun = runScriptCli(SCRIPT, truncated)
    expect(truncatedRun.status).toBe(1)
    expect(truncatedRun.stderr).toContain('looks truncated')
  })
})

describe('check-unrun-check-destinations against the real overlay', () => {
  it('is clean on the attached overlay (or the overlay is absent)', () => {
    const findings = scanUnrunCheckDestinations(process.cwd())
    expect(findings.violations).toEqual([])
  })
})
