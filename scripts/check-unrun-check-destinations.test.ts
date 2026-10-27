import { symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BASELINE_CEILING,
  BASELINE_PATH,
  findUnrunPhrase,
  fingerprint,
  scanUnrunCheckDestinations,
  storyBlocks,
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
const ZOOM = 'Not run: zoom.'
const NOT_RUN = 'Not run'
const NO_DESTINATION = 'no-destination'
const TEST_FILE = 'apps/web/src/lib/notice.test.ts'
const LEDGER =
  '# Deferred work\n\n### DW-613 copy call\n\nstatus: open — Trigger to revisit: 63-1.\n\n' +
  '### DW-23.2-1: dotted id\n\nstatus: open — Trigger to revisit: 23-2.\n'

const makeFixtureRoot = useFixtureRoots('unrun-check-destinations-', [ARTIFACTS_DIR])

type Fixture = {
  statuses?: string[]
  stories?: Record<string, string>
  files?: Record<string, string>
  ledger?: string
  baseline?: string
}

function fixture({
  statuses = [`${KEY}: done`, `${HUMAN_KEY}: backlog`],
  stories = {},
  files = {},
  ledger = LEDGER,
  baseline,
}: Fixture): string {
  const root = makeFixtureRoot()
  writeFixture(
    root,
    SPRINT_PATH,
    `development_status:\n${statuses.map((s) => `  ${s}\n`).join('')}`
  )
  writeFixture(root, LEDGER_PATH, ledger)
  if (baseline !== undefined) writeFixture(root, BASELINE_PATH, baseline)
  for (const [name, content] of Object.entries(stories)) {
    writeFixture(root, `${ARTIFACTS_DIR}/${name}`, content)
  }
  for (const [path, content] of Object.entries(files)) writeFixture(root, path, content)
  return root
}

function story(body: string): string {
  return `# Story 69.15\n\nStatus: done\n\n## Story\n\nAs a reviewer\n\n## Chrome pass\n\n${body}\n`
}

const scan = (f: Fixture, ceiling = 100) => scanUnrunCheckDestinations(fixture(f), ceiling)
const messages = (f: Fixture) => scan(f).violations.map((v) => v.message)
const oneStory = (body: string, extra: Partial<Fixture> = {}) =>
  messages({ stories: { [`${KEY}.md`]: story(body) }, ...extra })
const noDestination = (phrase: string, reason: string) =>
  `${KEY}: "${phrase}" names no destination; ${reason}`

describe('findUnrunPhrase (AC-1 phrase set)', () => {
  it.each([
    ['- Not run (extension cannot): 390 px, 200 % zoom.', 'Not run'],
    ['NOT RUN: members role change (one user only)', 'NOT RUN'],
    ['Not drivable: 390 px, keyboard-only', 'Not drivable'],
    ['the diff was not executed in this session', 'not executed'],
    ['EN novel page text was not captured', 'not captured'],
    ['the Chrome pass did not run', 'not run'],
    ['we could not run the composed host', 'could not run'],
    ['and could not drive the file dialog', 'could not drive'],
    ['steps the extension cannot run are listed', 'the extension cannot'],
    ['Chrome extension cannot resize the window', 'Chrome extension cannot'],
  ])('detects %s', (line, phrase) => {
    expect(findUnrunPhrase(line)).toBe(phrase)
  })

  it.each([
    'the vault_app role cannot run an ad-hoc DELETE',
    'Do NOT run `drizzle-kit generate`',
    'the query is not executed when the flag is off',
    'it must not run twice',
    'an extension cannot pass an arbitrary orgId',
    'every check ran green',
    'it could not runtime-load the module',
  ])('does not detect %s', (line) => {
    expect(findUnrunPhrase(line)).toBeUndefined()
  })
})

describe('storyBlocks', () => {
  it('joins hard-wrapped lines of a paragraph and of a list item, reporting the first line', () => {
    const blocks = storyBlocks('para one\ncontinues\n\n- item\n  wraps\n- next\n| a |\n| b |\n')
    expect(blocks).toEqual([
      { line: 1, text: 'para one continues' },
      { line: 4, text: '- item wraps' },
      { line: 6, text: '- next' },
      { line: 7, text: '| a |' },
      { line: 8, text: '| b |' },
    ])
  })

  it('leaves out the ## Story section, including its ### subsections, and fenced code', () => {
    const content =
      '# T\n\n## Story\n\nso that\n\n### Context\n\nquoted text\n\n## Notes\n\n```\ncode\n```\n\nafter\n'
    expect(storyBlocks(content).map((b) => b.text)).toEqual(['# T', '## Notes', 'after'])
  })

  it('strips CR from CRLF files', () => {
    expect(storyBlocks('a\r\nb\r\n')).toEqual([{ line: 1, text: 'a b' }])
  })
})

describe('scanUnrunCheckDestinations: detection scope (AC-1)', () => {
  it('fails an unrun block with no destination, naming path:line and the phrase', () => {
    expect(scan({ stories: { [`${KEY}.md`]: story('- Not run: 390 px.') } }).violations).toEqual([
      {
        kind: NO_DESTINATION,
        path: STORY_PATH,
        line: 11,
        message: `${KEY}: "Not run" names no destination`,
      },
    ])
  })

  it('catches a phrase wrapped across two lines', () => {
    expect(oneStory('the leg was not\nrun in Chrome')).toEqual([
      `${KEY}: "not run" names no destination`,
    ])
  })

  it('accepts a destination wrapped onto the next line of the same list item', () => {
    expect(oneStory(`- Not run: zoom; moved to backlog\n  story ${HUMAN_KEY}.`)).toEqual([])
  })

  it('scans only done stories, once per key', () => {
    expect(
      messages({ statuses: [`${KEY}: review`], stories: { [`${KEY}.md`]: story(ZOOM) } })
    ).toEqual([])
    const twice = scan({
      statuses: [`${KEY}: done`, `${KEY}: done`],
      stories: { [`${KEY}.md`]: story(ZOOM) },
    })
    expect([twice.doneCount, twice.violations.length]).toEqual([1, 1])
  })

  it('reads a spec-<key>.md story file and a letter-suffixed key', () => {
    const key = '24-5b-themes'
    const f = { statuses: [`${key}: done`], stories: { [`spec-${key}.md`]: story(ZOOM) } }
    expect(scan(f).violations[0]?.path).toBe(`${ARTIFACTS_DIR}/spec-${key}.md`)
  })
})

describe('scanUnrunCheckDestinations: destinations (AC-2)', () => {
  it('accepts a registered full backlog key, DW entries and a covering test file or key', () => {
    const body = [
      `- Not run (extension cannot): 390 px; moved to backlog story ${HUMAN_KEY}.`,
      '- EN text not captured; ledgered as DW-613.',
      '- EN text not captured; ledgered as DW-23.2-1.',
      `- Not run in Chrome; covered by \`${TEST_FILE}:12\`.`,
      `- Not executed here; covered by ${HUMAN_KEY}.`,
    ].join('\n')
    expect(oneStory(body, { files: { [TEST_FILE]: 'test' } })).toEqual([])
  })

  it('unwraps bold, italics and Markdown links around a destination', () => {
    const body = [
      `- Not run; moved to backlog story **${HUMAN_KEY}**.`,
      '- Not run; ledgered as **DW-613**.',
      `- Not run; covered by [the test](${TEST_FILE}).`,
      `- Not run; covered by _${HUMAN_KEY}_.`,
    ].join('\n')
    expect(oneStory(body, { files: { [TEST_FILE]: 'test' } })).toEqual([])
  })

  it('trims a 50k-character run of wrapper characters around a destination (S8786)', () => {
    const wrapped = '(' + '*'.repeat(50_000) + HUMAN_KEY + '.'.repeat(50_000)
    expect(oneStory('Not run; moved to backlog story ' + wrapped)).toEqual([])
  })

  it('is case-insensitive on the destination phrase', () => {
    expect(oneStory(`NOT RUN: zoom. Moved to backlog story ${HUMAN_KEY}`)).toEqual([])
  })

  it('rejects a short story id (the 63-3 "Moved to story 69-16" miss) and a key prefix', () => {
    expect(oneStory('Not run: zoom; moved to backlog story 69-16.')).toEqual([
      noDestination(NOT_RUN, 'moved to backlog story "69-16" is not a full story key'),
    ])
    expect(oneStory(`Not run; moved to backlog story ${HUMAN_KEY}/notes.md`)).toEqual([
      noDestination(
        NOT_RUN,
        `moved to backlog story "${HUMAN_KEY}/notes.md" is not a full story key`
      ),
    ])
  })

  it('rejects an unregistered key, a missing DW entry, a non-DW token and the story itself', () => {
    expect(oneStory('Not run; moved to backlog story 99-1-ghost-story.')).toEqual([
      noDestination(NOT_RUN, '99-1-ghost-story is not in sprint-status.yaml'),
    ])
    expect(oneStory('Not run; ledgered as DW-9999.')).toEqual([
      noDestination(NOT_RUN, 'DW-9999 is not in deferred-work.md'),
    ])
    expect(oneStory('Not run; ledgered as follow-up.')).toEqual([
      noDestination(NOT_RUN, 'ledgered as "follow-up" is not a DW id'),
    ])
    expect(oneStory(`Not run; moved to backlog story ${KEY}.`)).toEqual([
      noDestination(NOT_RUN, `${KEY} is the story itself`),
    ])
  })

  it.each([
    ['unit tests', 'unit', {}],
    ['a missing test file', 'apps/web/gone.test.ts', {}],
    ['a non-test file', 'package.json', { 'package.json': '{}' }],
    ['a directory', 'apps/web/e2e', { 'apps/web/e2e/x.spec.ts': '' }],
    ['an absolute path', '/etc/hosts', {}],
    ['a path outside the repo', '../outside/x.test.ts', {}],
    ['the overlay', `${ARTIFACTS_DIR}/x.test.ts`, { [`${ARTIFACTS_DIR}/x.test.ts`]: '' }],
  ])('rejects covered by %s', (_name, token, files) => {
    expect(oneStory(`Not run; covered by \`${token}\`.`, { files })).toEqual([
      noDestination(
        NOT_RUN,
        `covered by "${token}" is neither a registered story key nor a test file in the repo`
      ),
    ])
  })

  it('rejects a covered-by test file reached through a symlink that leaves the repo', () => {
    const outside = makeFixtureRoot()
    writeFixture(outside, 'x.test.ts', 'test')
    const root = fixture({
      stories: { [`${KEY}.md`]: story('Not run; covered by `link/x.test.ts`.') },
    })
    symlinkSync(outside, join(root, 'link'))
    expect(scanUnrunCheckDestinations(root, 100).violations).toHaveLength(1)
  })

  it('passes when one of several destinations resolves', () => {
    expect(oneStory(`Not run; ledgered as DW-9999, moved to backlog story ${HUMAN_KEY}.`)).toEqual(
      []
    )
  })
})

describe('scanUnrunCheckDestinations: fingerprint baseline (AC-3)', () => {
  const stories = { [`${KEY}.md`]: story(`${ZOOM}\n\nNot run: 390 px.`) }
  const baselineOf = (value: unknown) => JSON.stringify(value)

  it('skips exactly the fingerprinted blocks and fails a new one in the same story', () => {
    const one = scan({ stories, baseline: baselineOf({ [KEY]: [fingerprint(ZOOM)] }) })
    expect(one.grandfathered).toBe(1)
    expect(one.violations.map((v) => [v.kind, v.line])).toEqual([[NO_DESTINATION, 13]])

    const both = scan({
      stories,
      baseline: baselineOf({ [KEY]: [fingerprint(ZOOM), fingerprint('Not run: 390 px.')] }),
    })
    expect([both.grandfathered, both.violations]).toEqual([2, []])
  })

  it('treats an edited grandfathered line as new', () => {
    const edited = { [`${KEY}.md`]: story('Not run: zoom and 390 px.') }
    expect(
      scan({
        stories: edited,
        baseline: baselineOf({ [KEY]: [fingerprint(ZOOM)] }),
      }).violations.map((v) => v.kind)
    ).toEqual([NO_DESTINATION, 'stale-baseline'])
  })

  it('fails a fingerprint that no longer matches (the list only shrinks)', () => {
    const fixed = { [`${KEY}.md`]: story(`Not run: zoom; moved to backlog story ${HUMAN_KEY}`) }
    expect(
      messages({ stories: fixed, baseline: baselineOf({ [KEY]: [fingerprint(ZOOM)] }) })
    ).toEqual([
      `${KEY}: baseline fingerprint ${fingerprint(ZOOM)} matches no unresolved block any more; remove it`,
    ])
  })

  it('fails a baseline key that is not a done story with a file', () => {
    expect(messages({ baseline: baselineOf({ '5-99-gone': ['0123456789abcdef'] }) })).toEqual([
      '5-99-gone: in the baseline but not a done story with a story file; remove the entry',
    ])
  })

  it('fails a baseline above the ceiling', () => {
    const findings = scanUnrunCheckDestinations(
      fixture({ stories, baseline: baselineOf({ [KEY]: [fingerprint(ZOOM)] }) }),
      0
    )
    expect(findings.violations.map((v) => v.kind)).toContain('over-ceiling')
  })

  it.each([
    ['bad JSON', '{'],
    ['an array', '[]'],
    ['a count instead of fingerprints', '{"69-15-verify-region-split": 1}'],
    ['a bad fingerprint', '{"69-15-verify-region-split": ["zzz"]}'],
    ['an empty list', '{"69-15-verify-region-split": []}'],
  ])('reports a malformed baseline (%s) and grandfathers nothing', (_name, raw) => {
    const findings = scan({ stories, baseline: raw })
    expect(findings.grandfathered).toBe(0)
    expect(findings.violations.map((v) => v.kind).sort()).toEqual([
      'malformed-baseline',
      NO_DESTINATION,
      NO_DESTINATION,
    ])
  })

  it('fingerprints ignore whitespace and wrapping, not wording', () => {
    expect(fingerprint('Not run:  zoom.' + String.fromCodePoint(10))).toBe(fingerprint(ZOOM))
    expect(fingerprint('Not run: zoom!')).not.toBe(fingerprint(ZOOM))
    expect(fingerprint(ZOOM)).toMatch(/^[0-9a-f]{16}$/)
  })

  it('ships a positive ceiling', () => {
    expect(Number.isInteger(BASELINE_CEILING) && BASELINE_CEILING > 0).toBe(true)
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
    expect(run.stdout).toBe(
      'check-unrun-check-destinations: 1 done stories scanned, 1 unrun-check blocks with ' +
        'destinations, 0 grandfathered — OK\n'
    )
  })

  it('prints a FATAL block with path:line and a Fix line, exit 1', () => {
    const run = runScriptCli(SCRIPT, fixture({ stories: { [`${KEY}.md`]: story(ZOOM) } }))
    expect(run.status).toBe(1)
    expect(run.stderr).toContain(
      'FATAL: done stories record a check that was not run without naming where it went ' +
        '(epic-63 retro Finding 1):'
    )
    expect(run.stderr).toContain(`  - ${STORY_PATH}:11: ${KEY}: "Not run" names no destination`)
    expect(run.stderr).toContain('Fix: in the same paragraph or list item, write')
    expect(run.stdout).not.toContain('OK')
  })

  it('reads the baseline from the overlay', () => {
    const root = fixture({
      stories: { [`${KEY}.md`]: story(ZOOM) },
      baseline: JSON.stringify({ [KEY]: [fingerprint(ZOOM)] }),
    })
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('1 grandfathered — OK')
  })

  it('prints SKIPPED (never OK) when an overlay input is absent or a dangling symlink', () => {
    const run = runScriptCli(SCRIPT, makeFixtureRoot())
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
