import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  extractReviewSections,
  findTradeoffHits,
  isNegated,
  scanReviewTradeoffLedger,
} from './check-review-tradeoff-ledger.js'
import {
  runScriptCli,
  useFixtureRoots,
  writeFixture,
  writeFixtureSymlink,
} from './lib/fixture-test-helpers.js'

const ARTIFACTS_DIR = '_bmad-output/implementation-artifacts'
const SPRINT_PATH = `${ARTIFACTS_DIR}/sprint-status.yaml`
const LEDGER_PATH = `${ARTIFACTS_DIR}/deferred-work.md`
const SCRIPT = 'scripts/check-review-tradeoff-ledger.ts'
const KEY = '28-1-fix-secrets-list'
const STORY_PATH = `${ARTIFACTS_DIR}/${KEY}.md`
const REVIEW_HEADING = '## Senior Developer Review (AI)'
const LEFT_UNFIXED = 'left unfixed'
const TRIGGER = 'status: open — Trigger to revisit: the next change to `secrets-list.ts`.'

const makeFixtureRoot = useFixtureRoots('review-tradeoff-ledger-', [ARTIFACTS_DIR])

const texts = (line: string) => findTradeoffHits(line).map((h) => h.text)

function sprint(lines: string[]): string {
  return `generated: x\ndevelopment_status:\n${lines.map((l) => `  ${l}`).join('\n')}\n`
}

function story(review: string, extra = ''): string {
  return `# Story\n\nStatus: done\n\n## Dev Notes\n\nnotes\n\n${REVIEW_HEADING}\n\n${review}\n${extra}`
}

type Fixture = { sprint?: string; ledger?: string; stories?: Record<string, string> }

function fixture({ sprint: s, ledger, stories = {} }: Fixture): string {
  const root = makeFixtureRoot()
  if (s !== undefined) writeFixture(root, SPRINT_PATH, s)
  if (ledger !== undefined) writeFixture(root, LEDGER_PATH, ledger)
  for (const [name, content] of Object.entries(stories)) {
    writeFixture(root, `${ARTIFACTS_DIR}/${name}`, content)
  }
  return root
}

const messages = (f: Fixture) =>
  scanReviewTradeoffLedger(fixture(f)).violations.map((v) => v.message)

describe('findTradeoffHits: phrase set (AC-1.3) and negation guard (AC-1.4)', () => {
  it.each([
    [
      'Five Medium/Low findings were documented as accepted tradeoffs rather than a deferred-work.md entry',
      'accepted tradeoffs',
    ],
    [
      'already gracefully degrade to unknown rather than crash, left as documented tradeoffs. make ci',
      'left as documented tradeoffs',
    ],
    ['one low-severity cosmetic note (inaccurate test-count figure) left unfixed', LEFT_UNFIXED],
    ['Left unfixed (ledgered as DW-344):', 'Left unfixed'],
    ['two items left as trade-offs', 'left as trade-offs'],
    ['this is a documented trade-off', 'documented trade-off'],
    ['findings accepted as tradeoff', 'accepted as tradeoff'],
    ['everything below-threshold was kept', 'below-threshold'],
    ['everything below threshold was kept', 'below threshold'],
  ])('detects %s', (line, phrase) => {
    expect(texts(line)).toContain(phrase)
  })

  it.each([
    'Design decided (not left open)',
    'no finding was left unfixed',
    'none were accepted as trade-offs',
    'Nothing below threshold was deferred',
    'zero items left unfixed',
    'never documented as trade-offs',
    'shipped without accepted tradeoffs',
    'the finding was fixed; accepted and merged',
    'no deferred-manual-action language found, no deferred-work.md entry needed',
  ])('does not detect %s', (line) => {
    expect(findTradeoffHits(line)).toEqual([])
  })

  it('scopes negation to the same sentence and the preceding three words', () => {
    expect(texts('No change. The rest was left unfixed')).toEqual([LEFT_UNFIXED])
    expect(texts('not a blocker; one item was left unfixed')).toEqual([LEFT_UNFIXED])
    expect(texts('no, the reviewers decided it was left unfixed')).toEqual([LEFT_UNFIXED])
  })

  it('isNegated looks at the three words before the index', () => {
    expect(isNegated('there was no finding left unfixed', 21)).toBe(true)
    expect(isNegated('no one really cared, it stayed left unfixed', 31)).toBe(false)
  })
})

describe('findTradeoffHits: count phrase (AC-3)', () => {
  const count = (line: string) =>
    findTradeoffHits(line).flatMap((h) => (h.findings === undefined ? [] : [[h.text, h.findings]]))

  it.each([
    ['8 low + 1 medium left as documented tradeoffs', '8 low + 1 medium', 9],
    ['2 Medium + 1 Low left unfixed', '2 Medium + 1 Low', 3],
    ['10 low/medium left as-is', '10 low/medium', 10],
    ['3 LOW left as documented tradeoffs', '3 LOW', 3],
    ['Five Medium/Low findings were documented as accepted tradeoffs', 'Five Medium/Low', 5],
    ['1 high, 2 lows and 1 nit accepted', '1 high, 2 lows and 1 nit', 4],
    ['twelve info items below threshold', 'twelve info', 12],
  ])('%s -> "%s" (%d)', (line, text, n) => {
    expect(count(line)).toEqual([[text, n]])
  })

  it('only counts a severity count followed by an unfixed word within 60 characters', () => {
    expect(count('3 low fixed in 4e742040; 1 low left unfixed (DW-344)')).toEqual([['1 low', 1]])
    const inside = '10 low/medium noted, all either pre-existing or out-of-scope, left'
    expect(count(inside)).toEqual([['10 low/medium', 10]])
    const beyond =
      '10 low/medium noted, all either pre-existing or entirely out-of-scope for this story, and left'
    expect(count(beyond)).toEqual([])
  })

  it('treats a zero count as nothing left (8-3: "0 critical/high left unresolved")', () => {
    expect(count('Code review: fixed all findings, 0 critical/high left unresolved')).toEqual([])
    expect(
      count('0 critical/high findings, 2 low-severity observations left as documented')
    ).toEqual([['2 low', 2]])
  })

  it('ignores numbers without a severity word and severity words without a number', () => {
    expect(count('3 attempts left, 16 Tasks accepted')).toEqual([])
    expect(count('several medium/low findings left as documented tradeoffs')).toEqual([])
    expect(texts('several medium/low findings left as documented tradeoffs')).toEqual([
      'left as documented tradeoffs',
    ])
  })
})

describe('extractReviewSections (AC-1.2 a/a2)', () => {
  const titles = (content: string) => extractReviewSections(content).map((s) => s.heading)
  const lineTexts = (content: string) =>
    extractReviewSections(content).map((s) => s.lines.map((l) => l.text))

  it('takes level 2-4 review and Completion Notes headings, excluding elicitation/pre-mortem/red team', () => {
    const content =
      '# Review top\n## Senior Developer Review (AI)\na\n### Code Review\nb\n## Elicitation Review\nc\n' +
      '#### Pre-mortem review\nd\n### Red Team review\ne\n##### Deep review\nf\n### Completion Notes List\ng\n'
    expect(titles(content)).toEqual([REVIEW_HEADING, '### Completion Notes List'])
  })

  it('keeps nested subsections inside their parent and ends at the same or a higher level', () => {
    const content = '## Review\na\n### Action Items\nb\n## Dev Notes\nc\n'
    expect(lineTexts(content)).toEqual([['a', '### Action Items', 'b']])
  })

  it('ignores headings and text inside fences', () => {
    const content = '## Review\na\n```\n## Dev Notes\nleft unfixed\n```\nb\n## Next\n'
    expect(lineTexts(content)).toEqual([['a', 'b']])
    expect(titles('```\n## Review\n```\n')).toEqual([])
  })

  it('recognizes closing hashes and strips CR', () => {
    expect(titles('## Senior Developer Review (AI) ##\r\nx\r\n')).toEqual([REVIEW_HEADING])
    expect(lineTexts('## Review\r\nx\r\n')).toEqual([['x', '']])
  })
})

describe('scanReviewTradeoffLedger: tracking (AC-2)', () => {
  const untracked = story('Two findings left unfixed.')

  it('flags an untracked done story at the matching line, naming the section', () => {
    const result = scanReviewTradeoffLedger(
      fixture({
        sprint: sprint([`${KEY}: done`]),
        ledger: '',
        stories: { [`${KEY}.md`]: untracked },
      })
    )
    expect(result).toMatchObject({ doneCount: 1, hitCount: 1 })
    expect(result.violations).toEqual([
      {
        kind: 'untracked',
        path: STORY_PATH,
        line: 11,
        message: `${KEY}: "left unfixed" in "${REVIEW_HEADING}"`,
      },
    ])
  })

  it('reports a sprint-status comment hit at its sprint-status line', () => {
    expect(
      scanReviewTradeoffLedger(
        fixture({
          sprint: sprint(['epic-28: done', `${KEY}: done # one cosmetic note left unfixed`]),
          ledger: '',
          stories: { [`${KEY}.md`]: story('All fixed.') },
        })
      ).violations
    ).toEqual([
      {
        kind: 'untracked',
        path: SPRINT_PATH,
        line: 4,
        message: `${KEY}: "left unfixed" in its sprint-status comment`,
      },
    ])
  })

  it.each([
    [
      'source_spec with backticks and trailing text',
      `### DW-5: x\nsource_spec: \`${KEY}.md\` (review)\n${TRIGGER}\n`,
    ],
    ['spec- source_spec', `### DW-5: x\nsource_spec: spec-${KEY}.md\n${TRIGGER}\n`],
    ['heading token', `### DW-5: ${KEY} review trade-offs\n${TRIGGER}\n`],
    ['closed tracking entry', `### DW-5: x\nsource_spec: \`${KEY}.md\`\nstatus: done 2026-09-01\n`],
  ])('passes when tracked by %s', (_name, ledger) => {
    expect(
      messages({ sprint: sprint([`${KEY}: done`]), ledger, stories: { [`${KEY}.md`]: untracked } })
    ).toEqual([])
  })

  it('checks a spec-<key>.md story file', () => {
    expect(
      messages({
        sprint: sprint([`${KEY}: done`]),
        ledger: '',
        stories: { [`spec-${KEY}.md`]: untracked },
      })
    ).toHaveLength(1)
  })

  it('rule 3: a cited DW-ID satisfies it only when that entry names the story', () => {
    const cite = story('Left unfixed (ledgered as DW-344):')
    const s = sprint(['43-11-ledger-guards: done'])
    const file = { '43-11-ledger-guards.md': cite }
    for (const naming of [
      'origin: Story 43.11 review',
      'origin: 43-11 review',
      'see 43-11-ledger-guards',
    ]) {
      expect(
        messages({ sprint: s, ledger: `### DW-0344: x\n${naming}\n${TRIGGER}\n`, stories: file })
      ).toEqual([])
    }
    expect(
      messages({
        sprint: s,
        ledger: `### DW-344: x\norigin: Story 43.110 and 43-11b\n`,
        stories: file,
      })
    ).toEqual([
      `43-11-ledger-guards: "Left unfixed" in "${REVIEW_HEADING}"; cites DW-344, which does not name this story`,
    ])
    expect(messages({ sprint: s, ledger: '### DW-1: x\n', stories: file })).toEqual([
      `43-11-ledger-guards: "Left unfixed" in "${REVIEW_HEADING}"; cites DW-344, which is not in deferred-work.md`,
    ])
  })

  it("does not count the key in an unrelated entry's reason prose", () => {
    expect(
      messages({
        sprint: sprint([`${KEY}: done`]),
        ledger: `### DW-5: other\nreason: like ${KEY} did\n`,
        stories: { [`${KEY}.md`]: untracked },
      })
    ).toHaveLength(1)
  })

  it('does not let a tracked near-miss key satisfy another (22-1 vs 22-10)', () => {
    expect(
      messages({
        sprint: sprint(['22-10-x: done']),
        ledger: '### DW-5: 22-1-x trade-offs\nsource_spec: `22-1-x.md`\n',
        stories: { '22-10-x.md': untracked },
      })
    ).toHaveLength(1)
  })

  it('reports one entry per matched line, and all lines of a story pass or fail together', () => {
    const s = sprint([`${KEY}: done # 2 low left unfixed`])
    const stories = { [`${KEY}.md`]: story('Two findings left unfixed.\nAnd one below threshold.') }
    const result = scanReviewTradeoffLedger(fixture({ sprint: s, ledger: '', stories })).violations
    expect(result.map((v) => `${v.path}:${v.line}`)).toEqual([
      `${STORY_PATH}:11`,
      `${STORY_PATH}:12`,
      `${SPRINT_PATH}:3`,
    ])
    const ledger = `### DW-5: ${KEY}\nreason: (1) a (2) b\n${TRIGGER}\n`
    expect(messages({ sprint: s, ledger, stories })).toEqual([])
  })

  it.each(['review', 'in-progress', 'backlog'])('does not check a %s story', (status) => {
    expect(
      messages({
        sprint: sprint([`${KEY}: ${status}`]),
        ledger: '',
        stories: { [`${KEY}.md`]: untracked },
      })
    ).toEqual([])
  })

  it('checks 24-5b-shaped keys and never checks epic-*-gate keys', () => {
    const result = messages({
      sprint: sprint(['24-5b-x: done', 'epic-51-gate: done # left unfixed']),
      ledger: '',
      stories: { '24-5b-x.md': untracked, 'epic-51-gate.md': untracked },
    })
    expect(result).toEqual([`24-5b-x: "left unfixed" in "${REVIEW_HEADING}"`])
  })

  it('ignores phrases in non-review sections and fenced blocks, and missing or dangling story files', () => {
    const root = fixture({
      sprint: sprint([`${KEY}: done`, '1-1-missing: done', '3-4-dangling: done']),
      ledger: '',
      stories: {
        [`${KEY}.md`]:
          '## Dev Notes\nleft unfixed\n## Elicitation Log\nleft unfixed\n## Pre-mortem\nleft unfixed\n' +
          `${REVIEW_HEADING}\n\`\`\`\nleft unfixed\n\`\`\`\n`,
      },
    })
    writeFixtureSymlink(root, `${ARTIFACTS_DIR}/3-4-dangling.md`, '/nonexistent/3-4-dangling.md')
    expect(scanReviewTradeoffLedger(root)).toMatchObject({
      doneCount: 3,
      hitCount: 0,
      violations: [],
    })
  })

  it("attributes a comment hit only to the line's own key", () => {
    const result = messages({
      sprint: sprint(['28-1-a: done', '28-2-b: done # unlike 28-1, 1 low left unfixed']),
      ledger: '',
      stories: { '28-1-a.md': story('ok'), '28-2-b.md': story('ok') },
    })
    expect(result).toEqual(['28-2-b: "1 low" in its sprint-status comment'])
  })

  it('gives the same results for CRLF input', () => {
    const lf: Fixture = {
      sprint: sprint([`${KEY}: done # 1 low left unfixed`]),
      ledger: `### DW-5: x\nsource_spec: \`${KEY}.md\`\n${TRIGGER}\n`,
      stories: { [`${KEY}.md`]: untracked },
    }
    const crlf: Fixture = {
      sprint: lf.sprint?.replaceAll('\n', '\r\n'),
      ledger: lf.ledger?.replaceAll('\n', '\r\n'),
      stories: { [`${KEY}.md`]: untracked.replaceAll('\n', '\r\n') },
    }
    expect(messages(crlf)).toEqual(messages(lf))
    expect(messages(lf)).toEqual([`${KEY}: "1 low" (1 findings) but DW-5 itemizes 0`])
  })
})

describe('scanReviewTradeoffLedger: itemization (AC-3)', () => {
  const s = sprint(['43-5-env-writer: done'])
  const stories = { '43-5-env-writer.md': story('8 low + 1 medium left as documented tradeoffs.') }

  it('fails when the tracking entry itemizes fewer than N', () => {
    expect(
      messages({
        sprint: s,
        ledger: '### DW-321: 43-5-env-writer\nreason: not written down\n',
        stories,
      })
    ).toEqual(['43-5-env-writer: "8 low + 1 medium" (9 findings) but DW-321 itemizes 0'])
  })

  it('passes when the tracking entry enumerates (1)..(N)', () => {
    const items = Array.from({ length: 9 }, (_, i) => `(${i + 1}) item`).join(' ')
    expect(
      messages({ sprint: s, ledger: `### DW-321: 43-5-env-writer\nreason: ${items}\n`, stories })
    ).toEqual([])
  })

  it('sums the highest enumerators across several tracking entries', () => {
    const ledger =
      '### DW-1: 43-5-env-writer part 1\nreason: (1) a (2) b (3) c (4) d (5) e\n' +
      '### DW-2: x\nsource_spec: `43-5-env-writer.md`\nreason: (1) f (2) g (3) h (4) i\n'
    expect(messages({ sprint: s, ledger, stories })).toEqual([])
    const short = ledger.replace(' (4) i', '')
    expect(messages({ sprint: s, ledger: short, stories })).toEqual([
      '43-5-env-writer: "8 low + 1 medium" (9 findings) but DW-1, DW-2 itemize 8',
    ])
  })

  it('an untracked count hit is reported as untracked (not itemization)', () => {
    expect(messages({ sprint: s, ledger: '', stories })).toEqual([
      `43-5-env-writer: "8 low + 1 medium" in "${REVIEW_HEADING}"`,
    ])
  })
})

describe('scanReviewTradeoffLedger: "no deferred-work.md entry needed" (AC-4)', () => {
  const ledger = `### DW-5: ${KEY}\n${TRIGGER}\n`

  it('fails in the same source as a trade-off phrase, even when tracked', () => {
    const result = scanReviewTradeoffLedger(
      fixture({
        sprint: sprint([`${KEY}: done`]),
        ledger,
        stories: {
          [`${KEY}.md`]: story('A cosmetic note left unfixed.\nNo deferred-work.md entry needed.'),
        },
      })
    ).violations
    expect(result).toEqual([
      {
        kind: 'no-entry-needed',
        path: STORY_PATH,
        line: 12,
        message: `${KEY}: says "no deferred-work.md entry needed" while recording unfixed findings (pick-story C2)`,
      },
    ])
  })

  it('also fires inside a sprint-status comment', () => {
    expect(
      messages({
        sprint: sprint([`${KEY}: done # left as documented tradeoffs, no entry needed`]),
        ledger,
        stories: { [`${KEY}.md`]: story('ok') },
      })
    ).toEqual([
      `${KEY}: says "no deferred-work.md entry needed" while recording unfixed findings (pick-story C2)`,
    ])
  })

  it('passes the phrase alone (55-7) and across different sources', () => {
    expect(
      messages({
        sprint: sprint([
          '55-7-x: done # no deferred-manual-action language found, no deferred-work.md entry needed',
        ]),
        ledger: '',
        stories: { '55-7-x.md': story('ok') },
      })
    ).toEqual([])
    expect(
      messages({
        sprint: sprint([`${KEY}: done # one item left unfixed`]),
        ledger,
        stories: { [`${KEY}.md`]: story('No deferred-work.md entry needed for manual actions.') },
      })
    ).toEqual([])
  })
})

describe('check-review-tradeoff-ledger CLI (AC-6)', () => {
  const clean: Fixture = {
    sprint: sprint([`${KEY}: done`, '2-2-y: done']),
    ledger: `### DW-5: ${KEY}\n${TRIGGER}\n`,
    stories: { [`${KEY}.md`]: story('One finding left unfixed.'), '2-2-y.md': story('ok') },
  }

  it('(i) prints SKIPPED, not OK, when either input is absent', () => {
    const noSprint = runScriptCli(SCRIPT, fixture({ ledger: '' }))
    expect(noSprint.status).toBe(0)
    expect(noSprint.stdout).toContain(
      `check-review-tradeoff-ledger: SKIPPED — ${SPRINT_PATH} not found (private overlay not attached)`
    )
    const noLedger = runScriptCli(SCRIPT, fixture({ sprint: sprint([]) }))
    expect(noLedger.status).toBe(0)
    expect(noLedger.stdout).toContain(`SKIPPED — ${LEDGER_PATH} not found`)
    expect(noSprint.stdout + noLedger.stdout).not.toContain('— OK')
  })

  it('(ii) prints SKIPPED for a dangling overlay symlink', () => {
    const root = fixture({ sprint: sprint([]) })
    writeFixtureSymlink(root, LEDGER_PATH, '/nonexistent/deferred-work.md')
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('SKIPPED')
    expect(run.stdout).toContain('dangling')
  })

  it('(iii) is FATAL when an input is a directory', () => {
    const root = fixture({ sprint: sprint([]) })
    mkdirSync(join(root, LEDGER_PATH))
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('FATAL')
  })

  it('(iv) prints OK on clean data', () => {
    const run = runScriptCli(SCRIPT, fixture(clean))
    expect(run.status).toBe(0)
    expect(run.stdout).toBe(
      'check-review-tradeoff-ledger: 2 done stories scanned, 1 with trade-off language, all tracked — OK\n'
    )
  })

  it('(v) is FATAL on stderr with repo-relative lines and a Fix paragraph', () => {
    const root = fixture({ ...clean, ledger: '' })
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(1)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain(
      'FATAL: done stories record review findings as unfixed/accepted trade-offs with no deferred-work.md entry tracking them'
    )
    expect(run.stderr).toContain(
      `  - ${STORY_PATH}:11: ${KEY}: "left unfixed" in "${REVIEW_HEADING}"`
    )
    expect(run.stderr).toContain('Fix:')
    expect(run.stderr).toContain('pnpm -s next-dw-id --fetch')
    expect(run.stderr).not.toContain(root)
  })
})
