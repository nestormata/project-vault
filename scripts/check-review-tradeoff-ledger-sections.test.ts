import { describe, expect, it } from 'vitest'
import { scanReviewTradeoffLedger } from './check-review-tradeoff-ledger.js'
import {
  runScriptCli,
  useFixtureRoots,
  writeFixture,
  writeFixtureDir,
  writeFixtureSymlink,
} from './lib/fixture-test-helpers.js'
import {
  DISPOSITION_PHRASES,
  dispositionHits,
  extractRiskScopeSections,
  findCheckedDefers,
  firstDispositionIndex,
} from './lib/section-ledger-rules.js'

const ARTIFACTS_DIR = '_bmad-output/implementation-artifacts'
const SPRINT_PATH = `${ARTIFACTS_DIR}/sprint-status.yaml`
const LEDGER_PATH = `${ARTIFACTS_DIR}/deferred-work.md`
const SCRIPT = 'scripts/check-review-tradeoff-ledger.ts'
const KEY = '28-1-fix-secrets-list'
const OTHER_KEY = '43-23-wire-guards'
const STORY_PATH = `${ARTIFACTS_DIR}/${KEY}.md`
const TRIGGER = 'status: open — Trigger to revisit: the next change to `secrets-list.ts`.'
const RESIDUAL_ACCEPTED = '### Residual risks (documented, accepted — not fixed here)'
const SCOPE_OUT = '### Scope Boundaries (explicitly out)'
const SECTION_KIND = 'unledgered-section'
const DEFER_KIND = 'unledgered-defer'
const DEFER_BULLET = '- [x] [Review][Defer] LOW: stale comment in client.ts'

const makeFixtureRoot = useFixtureRoots('review-tradeoff-ledger-sections-', [ARTIFACTS_DIR])

function sprint(lines: string[]): string {
  return `generated: x\ndevelopment_status:\n${lines.map((l) => `  ${l}`).join('\n')}\n`
}

function story(body: string): string {
  return `# Story\n\nStatus: done\n\n${body}\n`
}

function entry(id: number, specKey: string): string {
  return `### DW-${id}: finding\n- source_spec: \`${specKey}.md\`\n${TRIGGER}\n\n`
}

type Fixture = { status?: string; ledger?: string; body: string; extraKeys?: string[] }

function scan({ status = 'done', ledger = '', body, extraKeys = [] }: Fixture) {
  const root = makeFixtureRoot()
  writeFixture(root, SPRINT_PATH, sprint([`${KEY}: ${status}`, ...extraKeys]))
  writeFixture(root, LEDGER_PATH, ledger)
  writeFixture(root, STORY_PATH, story(body))
  return scanReviewTradeoffLedger(root)
}

const messages = (f: Fixture) => scan(f).violations.map((v) => v.message)
const kinds = (f: Fixture) => scan(f).violations.map((v) => v.kind)

const titles = (content: string) => extractRiskScopeSections(content).map((s) => s.heading)

describe('extractRiskScopeSections (AC-1)', () => {
  it.each([
    '### Residual risks (documented, accepted — not fixed here)',
    '## Known Scope Boundaries',
    '### Scope boundary: skill-file location',
    '#### Residual risks',
    '### Known limits',
    '### Known limitations',
    '### Accepted residual risk / known limitations',
    '### Residual windows (documented, not fixed)',
    '## Residual exposure after this story',
    '### Residual gaps',
    '### What is documented, not fixed',
    '### Not addressed here',
  ])('selects %s', (heading) => {
    expect(titles(`${heading}\n\n- x\n`)).toEqual([heading])
  })

  it.each([
    '### AC-14: README — GitLab CI v1 Documentation (v2 Scope Boundary)',
    '### AC-3: Create Machine User — Happy Path + Scope Boundary Response',
    '# Residual risks',
    '##### Residual risks',
    '## Residual risks (elicitation)',
    '## Pre-mortem: residual risks',
    '### Residual-risks',
    '### Subresidual risks',
    '### Unknown limits',
    '### AC-4: Residual windows are logged',
    '### Residual-risk elicitation round',
    '### Residuals',
    '### Nonresidual state',
    '### Residual',
    '### Not fixed-width fonts',
    '### D9 — Cross-org bleed: accepted, not fixed',
    '### D8 — tracked, not fixed, by this story',
  ])('ignores %s', (heading) => {
    expect(titles(`${heading}\n\n- x\n`)).toEqual([])
  })

  it('ends a section at the next heading of the same level and returns the next as its own', () => {
    const content = `${RESIDUAL_ACCEPTED}\n\n- a\n\n${SCOPE_OUT}\n\n- b\n`
    const sections = extractRiskScopeSections(content)
    expect(sections.map((s) => s.heading)).toEqual([RESIDUAL_ACCEPTED, SCOPE_OUT])
    expect(sections[0]?.lines.map((l) => l.line)).toEqual([2, 3, 4])
    expect(sections[1]?.lines.map((l) => l.line)).toEqual([6, 7, 8])
  })

  it('keeps deeper subsections inside a level-2 section', () => {
    const content = '## Known Scope Boundaries\n\n### One\n- a\n### Two\n- b\n## Next\n'
    const [section, ...rest] = extractRiskScopeSections(content)
    expect(rest).toEqual([])
    expect(section?.lines.map((l) => l.text)).toContain('- b')
  })

  it('finds a nested section independent of the review heading', () => {
    const content = '## Senior Developer Review (AI)\n\n#### Residual risks\n\n- x\n'
    expect(titles(content)).toEqual(['#### Residual risks'])
  })

  it('ignores fenced headings without leaking fence state, including ~~~', () => {
    const content = `\`\`\`\n### Residual risks\n- accepted\n\`\`\`\n~~~\n### Known limits\n~~~\n${SCOPE_OUT}\n`
    expect(titles(content)).toEqual([SCOPE_OUT])
  })

  it('handles CRLF and EOF without a trailing newline like LF', () => {
    const lf = `${RESIDUAL_ACCEPTED}\n\n- a`
    const crlf = lf.replaceAll('\n', '\r\n')
    expect(extractRiskScopeSections(crlf)).toEqual(extractRiskScopeSections(lf))
    expect(extractRiskScopeSections(lf)[0]?.lines.at(-1)?.text).toBe('- a')
  })

  it('does not return a bold run-in label (documented blind spot, Q4)', () => {
    expect(titles('**Accepted residual risks (documented, not blocking):**\n- a\n')).toEqual([])
  })

  it('lets an unclosed fence hide every later section (shared with Guard A, Q5)', () => {
    expect(titles(`\`\`\`\nunclosed\n${RESIDUAL_ACCEPTED}\n- a\n`)).toEqual([])
  })
})

function hitsOf(content: string) {
  return extractRiskScopeSections(content).flatMap(dispositionHits)
}

describe('disposition detection (AC-2)', () => {
  it.each([
    'The risk is accepted for now.',
    'This needs Nestor.',
    'needs a decision before release',
    'waiting on Nestor',
    'file a follow-up story',
    'a followup is planned',
    'this is deferred',
    'we defer it',
    'deferring the rest',
  ])('hits %s', (text) => {
    expect(firstDispositionIndex(text)).toBeDefined()
  })

  it.each([
    'no follow-up needed',
    'none accepted',
    'Deferred: none planned.',
    'Follow-up: n/a',
    '**Deferred:** nothing',
    'never deferred',
    '- Deferred: none planned. Anything found and not fixed gets a DW entry with a revisit trigger.',
    'Changing auth_handoff_page_title, the MFA flow, or the generic rejection copy.',
  ])('misses %s', (text) => {
    expect(firstDispositionIndex(text)).toBeUndefined()
  })

  it('has every phrase in the closed list firing on its own', () => {
    expect(DISPOSITION_PHRASES).toHaveLength(5)
  })

  it('marks every top-level bullet of a title-implied section, whatever its words', () => {
    const hits = hitsOf(
      `${RESIDUAL_ACCEPTED}\n\nintro paragraph\n\n- tolerated by design\n- another\n`
    )
    expect(hits.map((h) => h.line)).toEqual([5, 6])
  })

  it.each(['### Residual risk', '### Known limits', '### Accepted residual risk / limits'])(
    'treats %s as title-implied',
    (heading) => {
      expect(hitsOf(`${heading}\n\n- won't fix\n`)).toHaveLength(1)
    }
  )

  it('hits the paragraph of a title-implied section with no bullet, but not None / N/A', () => {
    expect(hitsOf('### Known limits\n\nThe thing is slow.\n')).toHaveLength(1)
    expect(hitsOf('### Known limits\n\nNone.\n')).toEqual([])
    expect(hitsOf('### Known limits\n\nN/A — no residual risks.\n')).toEqual([])
  })

  it('keeps Scope boundar titles lexical (descriptive bullet is not a hit)', () => {
    const content = `${SCOPE_OUT}\n\n- Changing auth_handoff_page_title, the MFA flow, or the generic rejection copy.\n`
    expect(hitsOf(content)).toEqual([])
  })

  it('reports a multi-line block once at the first hit line', () => {
    const content = `${SCOPE_OUT}\n\n- A new column\n  needs CM coordination.\n  If Nestor wants it, file a follow-up.\n- other\n`
    const hits = hitsOf(content)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.line).toBe(4)
    expect(hits[0]?.text).toContain('follow-up')
  })

  it('does not hit inside a fence and does scan an HTML comment', () => {
    expect(hitsOf(`${SCOPE_OUT}\n\n\`\`\`\n- deferred\n\`\`\`\n`)).toEqual([])
    expect(hitsOf(`${SCOPE_OUT}\n\n<!-- deferred -->\n`)).toHaveLength(1)
  })
})

describe('residual-window headings (70-5 AC-1, AC-3)', () => {
  const WINDOWS = '### Residual windows (documented, not fixed)'
  const BULLET_ONE =
    '- A provider `send()` hanging longer than the 15-minute lease: pg-boss expires the job at the same\n' +
    '  15 minutes and retries; the retry can reclaim while the hung call is still running. Covered on the\n' +
    '  provider path by `queueRowId` dedupe. A\n' +
    "  per-send timeout below the lease is a candidate follow-up (not in 70.3's current scope)."

  it('implies a disposition when the title says not fixed, but not for a bare Residual windows', () => {
    expect(hitsOf(`${WINDOWS}\n\n- Rolling deploy overlap.\n`)).toHaveLength(1)
    expect(hitsOf('### Residual windows\n\n- Rolling deploy overlap.\n')).toEqual([])
    expect(hitsOf('### Residual windows\n\n- A candidate follow-up exists.\n')).toHaveLength(1)
  })

  it('pins the real 70-1 heading and first bullet as a scanned disposition hit', () => {
    const content = `${WINDOWS}\n\n${BULLET_ONE}\n`
    expect(titles(content)).toEqual([WINDOWS])
    const hits = hitsOf(content)
    expect(hits).toHaveLength(1)
    expect(hits[0]?.text).toContain('candidate follow-up')
  })

  it('reports an uncited Residual windows section (the retro finding)', () => {
    expect(kinds({ body: `${WINDOWS}\n\n${BULLET_ONE}\n` })).toEqual([SECTION_KIND])
  })

  it('is clean once the bullet cites a DW that names the story', () => {
    const body = `${WINDOWS}\n\n${BULLET_ONE.replace('scope).', 'scope) (ledgered as DW-5).')}\n`
    expect(messages({ body, ledger: entry(5, KEY) })).toEqual([])
  })
})

describe('citations (AC-3) through scanReviewTradeoffLedger', () => {
  it('fails with no citation, passes once a DW exists and names the story', () => {
    const bare = { body: '### Residual risks\n\n- **Gap.** Fails closed.\n' }
    expect(kinds(bare)).toEqual([SECTION_KIND])
    const cited = {
      body: '### Residual risks\n\n- **Gap.** Fails closed (ledgered as DW-5).\n',
      ledger: entry(5, KEY),
    }
    expect(messages(cited)).toEqual([])
  })

  it('reports a missing DW and a DW that names another story', () => {
    const body = '### Residual risks\n\n- **Gap.** (ledgered as DW-999)\n'
    expect(messages({ body })[0]).toContain('cites DW-999, which is not in deferred-work.md')
    const other = { body: '### Residual risks\n\n- x DW-6\n', ledger: entry(6, '9-9-other') }
    expect(messages(other)[0]).toContain('cites DW-6, which does not name this story')
  })

  it('accepts a closed DW entry', () => {
    const ledger = `### DW-5: x\n- source_spec: \`${KEY}.md\`\nstatus: done — fixed in 66-9\n\n`
    expect(messages({ body: '### Known limits\n\n- slow DW-5\n', ledger })).toEqual([])
  })

  it('does not let DW-41 satisfy a need for DW-4', () => {
    const body = '### Known limits\n\n- slow DW-4\n'
    expect(kinds({ body, ledger: entry(41, KEY) })).toEqual([SECTION_KIND])
  })

  it('accepts a registered backlog key, rejects self, unknown and bare numbers', () => {
    const base = (cite: string) => ({
      body: `${SCOPE_OUT}\n\n- Needs a decision. ${cite}\n`,
      extraKeys: [`${OTHER_KEY}: backlog`],
    })
    expect(messages(base(`See ${OTHER_KEY}`))).toEqual([])
    expect(messages(base(`See ${KEY}`))[0]).toContain('which is the story itself')
    expect(messages(base('See 99-9-no-such-story'))[0]).toContain(
      'cites 99-9-no-such-story, which is not in sprint-status.yaml'
    )
    expect(kinds(base('See 43-23'))).toEqual([SECTION_KIND])
  })

  it('counts only the block own lines, not the neighbour or the heading', () => {
    const body = `### Known limits\n\n- first one\n- second DW-5\n`
    expect(kinds({ body, ledger: entry(5, KEY) })).toEqual([SECTION_KIND])
  })

  it('finds the citation on a continuation line of the block', () => {
    const body = '### Known limits\n\n- slow\n  more words\n  ledgered as DW-5\n'
    expect(messages({ body, ledger: entry(5, KEY) })).toEqual([])
  })

  it('ignores a citation that lives only in the Dev Agent Record', () => {
    const body = '### Known limits\n\n- slow\n\n## Dev Agent Record\n\nledgered as DW-5\n'
    expect(kinds({ body, ledger: entry(5, KEY) })).toEqual([SECTION_KIND])
  })
})

describe('findCheckedDefers and Rule D (AC-4)', () => {
  it.each([
    DEFER_BULLET,
    '    - [x] [Review][Defer] nested',
    '* [X] [Review][Defer] star',
    '- [x] [review][defer] lowercase tag',
  ])('matches %s', (line) => {
    expect(findCheckedDefers(`${line}\n`)).toHaveLength(1)
  })

  it.each([
    '- [ ] [Review][Defer] unchecked',
    '- [x] [Review][Patch] fixed',
    '- [x] [Review][Dismiss] no',
    '- [x] [Review][Rejected] no',
    '- [x] [Review][Decision] no',
    '- [x] [Review][Patch] deferred in prose',
    '- [x] [Review][Deferred] other spelling',
  ])('ignores %s', (line) => {
    expect(findCheckedDefers(`${line}\n`)).toEqual([])
  })

  it('ignores fenced bullets and ends a block at the next bullet, blank line or heading', () => {
    expect(findCheckedDefers(`\`\`\`\n${DEFER_BULLET}\n\`\`\`\n`)).toEqual([])
    const [first] = findCheckedDefers(`${DEFER_BULLET}\n  cont\n- next\n`)
    expect(first?.text).toBe(`${DEFER_BULLET}\n  cont`)
    expect(findCheckedDefers(`${DEFER_BULLET}\n\n  later DW-5\n`)[0]?.text).toBe(DEFER_BULLET)
    expect(findCheckedDefers(`${DEFER_BULLET}\n## Head\n`)[0]?.text).toBe(DEFER_BULLET)
  })

  it('fails a checked defer with no DW and names the line', () => {
    const result = scan({ body: `## Review\n\n${DEFER_BULLET}\n` })
    expect(result.violations).toHaveLength(1)
    expect(result.violations[0]).toMatchObject({ kind: DEFER_KIND, line: 7, path: STORY_PATH })
    expect(result.violations[0]?.message).toContain(
      'checked [Review][Defer] bullet has no ledger entry'
    )
    expect(result.deferCount).toBe(1)
  })

  it('passes with a DW that names the story, many bullets may share one entry', () => {
    const body = `${DEFER_BULLET} DW-5\n- [x] [Review][Defer] b DW-5\n- [x] [Review][Defer] c DW-7\n`
    expect(messages({ body, ledger: entry(5, KEY) + entry(7, KEY) })).toEqual([])
  })

  it('rejects a DW naming another story, and a story-key-only citation', () => {
    const wrong = { body: `${DEFER_BULLET} DW-5\n`, ledger: entry(5, '9-9-other') }
    expect(messages(wrong)[0]).toContain('cites DW-5, which does not name this story')
    const keyOnly = {
      body: `${DEFER_BULLET} Follow-up: ${OTHER_KEY}\n`,
      extraKeys: [`${OTHER_KEY}: backlog`],
    }
    expect(kinds(keyOnly)).toEqual([DEFER_KIND])
  })

  it('leaves unchecked defers to check-story-review-deferrals', () => {
    expect(kinds({ body: '- [ ] [Review][Defer] x. Follow-up: 9-9-y\n' })).toEqual([])
  })

  it('only checks done stories, and goes red when flipped to done', () => {
    const body = `${DEFER_BULLET}\n`
    expect(kinds({ body, status: 'review' })).toEqual([])
    expect(kinds({ body, status: 'in-progress' })).toEqual([])
    expect(kinds({ body, status: 'done' })).toEqual([DEFER_KIND])
  })

  it('reports exactly the uncited bullets of a mixed file at their own lines', () => {
    const body = [
      '- [x] [Review][Defer] a DW-5',
      '- [x] [Review][Defer] b',
      '- [x] [Review][Defer] c DW-5',
      '- [x] [Review][Defer] d',
      '- [x] [Review][Defer] e DW-5',
    ].join('\n')
    const result = scan({ body, ledger: entry(5, KEY) })
    expect(result.violations.map((v) => v.line)).toEqual([6, 8])
  })

  it('reads a spec-<key>.md story file', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_PATH, sprint([`${KEY}: done`]))
    writeFixture(root, LEDGER_PATH, '')
    writeFixture(root, `${ARTIFACTS_DIR}/spec-${KEY}.md`, story(DEFER_BULLET))
    expect(scanReviewTradeoffLedger(root).violations.map((v) => v.kind)).toEqual([DEFER_KIND])
  })
})

describe('dedupe and combination with Guard A (AC-5)', () => {
  it('reports a line that is a Guard A phrase and a checked defer once, under Guard A', () => {
    const body = '## Senior Developer Review (AI)\n\n- [x] [Review][Defer] LOW left unfixed\n'
    const result = scan({ body })
    expect(result.violations.map((v) => v.kind)).toEqual(['untracked'])
  })

  it('reports each of Rule S and Rule D on distinct lines', () => {
    const body = `${DEFER_BULLET}\n\n### Residual risks\n\n- thing\n`
    expect(kinds({ body }).toSorted()).toEqual([DEFER_KIND, SECTION_KIND])
  })
})

describe('real-shape regressions (AC-8): red before, green after', () => {
  const R60_5 = [
    RESIDUAL_ACCEPTED,
    '',
    '- **Blocked waiter (considered in R3, no `lock_timeout` added).** A concurrent loser waits on the',
    '  winner. Revisit if a lock wait ever shows up in production.',
    '- **Commit outcome unknown.** If the connection drops *during* `COMMIT`, Postgres may have',
    '  committed. This is inherent to any client/DB boundary, rare, and fails closed.',
    '- **Cross-service gap after commit.** If the API commits and the response never reaches the web',
    '  `load`, the claim is consumed. A DB transaction cannot cover this.',
    '',
    SCOPE_OUT,
    '',
    '- Changing `/confirm`s burn semantics (Design Decision 5).',
  ]

  it('60-5: three residual risks fail, then pass when cited with a DW naming the story', () => {
    const red = R60_5.join('\n')
    expect(kinds({ body: red })).toEqual([SECTION_KIND, SECTION_KIND, SECTION_KIND])
    const green = R60_5.map((l) => (l.startsWith('- **') ? `${l} (ledgered as DW-399)` : l)).join(
      '\n'
    )
    expect(messages({ body: green, ledger: entry(399, KEY) })).toEqual([])
  })

  it('60-4: the follow-up scope bullet fails, then passes when cited', () => {
    const bullet = [
      SCOPE_OUT,
      '',
      '- A `users.display_name` column — needs CM coordination (fix plan F10). If Nestor wants it, file a',
      '  follow-up; do not build it here.',
      '- Wiring the other `VAULT_HANDOFF_*` keys into base compose.',
    ]
    expect(kinds({ body: bullet.join('\n') })).toEqual([SECTION_KIND])
    const green = [...bullet]
    green[3] = '  follow-up; do not build it here (ledgered as DW-400).'
    expect(messages({ body: green.join('\n'), ledger: entry(400, KEY) })).toEqual([])
  })

  it('61-1: the checked defer bullet fails, then passes when cited', () => {
    const bullet =
      '- [x] [Review][Defer] LOW (Edge Case) — refreshAccessSession single-flight joins a refresh started by an other caller'
    expect(kinds({ body: bullet })).toEqual([DEFER_KIND])
    expect(messages({ body: `${bullet} — ledgered as DW-410`, ledger: entry(410, KEY) })).toEqual(
      []
    )
  })
})

describe('check-review-tradeoff-ledger CLI with Rules S and D (AC-5)', () => {
  function cliRoot(body: string, ledger = ''): string {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_PATH, sprint([`${KEY}: done`]))
    writeFixture(root, LEDGER_PATH, ledger)
    writeFixture(root, STORY_PATH, story(body))
    return root
  }

  it('(i) prints SKIPPED when either input is absent', () => {
    const noSprint = makeFixtureRoot()
    writeFixture(noSprint, LEDGER_PATH, '')
    expect(runScriptCli(SCRIPT, noSprint).stdout).toContain('SKIPPED')
    const noLedger = makeFixtureRoot()
    writeFixture(noLedger, SPRINT_PATH, sprint([]))
    expect(runScriptCli(SCRIPT, noLedger).stdout).toContain('SKIPPED')
  })

  it('(ii) prints SKIPPED for a dangling overlay symlink', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_PATH, sprint([]))
    writeFixtureSymlink(root, LEDGER_PATH, '/nonexistent/deferred-work.md')
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('SKIPPED')
  })

  it('(iii) is FATAL when an input is a directory', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_PATH, sprint([]))
    writeFixtureDir(root, LEDGER_PATH)
    expect(runScriptCli(SCRIPT, root).status).toBe(1)
  })

  it('(iv) prints OK with the new counts on clean data', () => {
    const body = `### Known limits\n\n- slow DW-5\n\n${DEFER_BULLET} DW-5\n`
    const run = runScriptCli(SCRIPT, cliRoot(body, entry(5, KEY)))
    expect(run.status).toBe(0)
    expect(run.stdout).toBe(
      'check-review-tradeoff-ledger: 1 done stories scanned, 0 with trade-off language, 1 with section dispositions, 1 with checked defers, all tracked — OK\n'
    )
  })

  it('(v) is FATAL on stderr, one block per kind with a Fix paragraph and repo-relative paths', () => {
    const root = cliRoot(`${DEFER_BULLET}\n\n### Known limits\n\n- slow\n`)
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(1)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain(
      'FATAL: done stories record accepted residual risks / scope boundaries / known limits with no deferred-work.md entry or backlog story (epic-60 retro Finding 4):'
    )
    expect(run.stderr).toContain(
      'FATAL: done stories carry checked [Review][Defer] bullets with no deferred-work.md entry (epic-61 retro Finding 1):'
    )
    expect(run.stderr).toContain(`  - ${STORY_PATH}:9: ${KEY}: "- slow"`)
    expect(run.stderr).toContain(`  - ${STORY_PATH}:5: ${KEY}: checked [Review][Defer] bullet`)
    expect(run.stderr.match(/^Fix:/gm)).toHaveLength(2)
    expect(run.stderr).not.toContain(root)
  })
})
