import { describe, expect, it } from 'vitest'
import {
  checkTriggerLabel,
  entryState,
  findTriggerViolations,
  scanDeferredWorkTriggers,
} from './check-deferred-work-triggers.js'
import { parseDwEntries } from './lib/deferred-work-ledger.js'
import {
  runScriptCli,
  useFixtureRoots,
  writeFixture,
  writeFixtureDir,
  writeFixtureSymlink,
} from './lib/fixture-test-helpers.js'

const ARTIFACTS_DIR = '_bmad-output/implementation-artifacts'
const LEDGER_PATH = `${ARTIFACTS_DIR}/deferred-work.md`
const SCRIPT = 'scripts/check-deferred-work-triggers.ts'
const TRIGGER = 'Trigger to revisit: the next change to `scripts/lib/scan-utils.ts`.'

const OPEN = 'open'
const OPEN_X = 'status: open — x'
const BARE_OPEN = 'status: open'
const CLOSED = 'closed'
const DW1_NO_TRIGGER = 'DW-1 is open but names no revisit trigger'

const makeFixtureRoot = useFixtureRoots('deferred-work-triggers-', [ARTIFACTS_DIR])

const messages = (content: string) => findTriggerViolations(content).map((v) => v.message)
const entry = (id: string, ...body: string[]) => `### DW-${id}: title\n\n${body.join('\n')}\n\n`

describe('entryState (AC-5.2)', () => {
  const stateOf = (body: string) => {
    const [first] = parseDwEntries(`### DW-1: t\n${body}\n`)
    if (!first) throw new Error('fixture has no DW entry')
    return entryState(first)
  }

  it.each([
    [OPEN_X, OPEN],
    ['status: open (item 2 resolved)', OPEN],
    [BARE_OPEN, OPEN],
    ['status: **done** 2026-09-01', CLOSED],
    ['status: `closed`', CLOSED],
    ['status: resolved (2026-09-28)', CLOSED],
    ['status: superseded by DW-9', CLOSED],
    ['status: withdrawn', CLOSED],
    ['status: wontfix', CLOSED],
    ['status: obsolete', CLOSED],
    ['status: duplicate of DW-3', CLOSED],
    ['status: in-progress', OPEN],
    ['status: partially resolved', OPEN],
    ['status: partially-resolved', OPEN],
    ['status: deferred', OPEN],
    ['status: blocked on X', OPEN],
    ['status: pending', OPEN],
    ['status: Open — x', OPEN],
  ])('%s -> %s', (line, kind) => {
    expect(stateOf(line).kind).toBe(kind)
  })

  it('reports an unknown status word and a missing status line', () => {
    expect(stateOf('status: opne — typo')).toMatchObject({ kind: 'unknown', word: 'opne' })
    expect(stateOf('reason: r')).toMatchObject({ kind: 'missing' })
  })

  it('drops only trailing punctuation and markup from the status word', () => {
    expect(stateOf('status: open.,:;—- x')).toMatchObject({ kind: 'open', token: 'open.,:;—-' })
    expect(stateOf('status: `done`.')).toMatchObject({ kind: 'closed' })
    expect(stateOf('status: **in-progress**—')).toMatchObject({ kind: 'open' })
    expect(stateOf('status: done--x')).toMatchObject({ kind: 'unknown', word: 'done--x' })
    expect(stateOf('status: .open')).toMatchObject({ kind: 'unknown', word: '.open' })
    expect(stateOf('status: ...')).toMatchObject({ kind: 'unknown', word: '' })
  })

  it('handles long adversarial status tokens in linear time', () => {
    const started = performance.now()
    expect(stateOf(`status: open${'.'.repeat(50_000)}x`)).toMatchObject({ kind: 'unknown' })
    expect(stateOf(`status: open${'-—'.repeat(25_000)}`)).toMatchObject({ kind: 'open' })
    expect(stateOf(`status:${' '.repeat(50_000)}open`)).toMatchObject({ kind: 'open' })
    expect(performance.now() - started).toBeLessThan(500)
  })

  it('reports every status line when there is more than one', () => {
    expect(stateOf('status: done\nreason: r\nstatus: open')).toMatchObject({
      kind: 'multiple',
      lines: [2, 4],
    })
  })
})

describe('checkTriggerLabel (AC-5.3)', () => {
  it.each([
    'status: open. Trigger to revisit: the next change to `scan-utils.ts`',
    'status: open — x. Trigger to revisit (added 2026-09-27, epic-59 retro Finding 4): the next packages/extension-api version bump',
    'status: open. Triggers: (1) when Epic 51 Story 51.2 starts',
    "status: open. Trigger: when Epic 51's architecture gate clears",
    'trigger: the next change to apps/api/src/main.ts',
    'update (2026-09-27): Trigger to revisit: the next change to health.ts',
    'Trigger to revisit: if it recurs in check-story-status-sync on main',
  ])('accepts %s', (line) => {
    expect(checkTriggerLabel(line)).toEqual({ kind: 'ok' })
  })

  it.each([
    'Trigger to revisit: TBD',
    'Trigger: later.',
    'Trigger to revisit: tracked as debt only',
    'Trigger to revisit: n/a — nothing to do here at all',
    'Trigger: none yet, will decide eventually',
    'Trigger to revisit: when time permits after the release',
    'Trigger to revisit: if it recurs',
    'Trigger to revisit: If it becomes a problem.',
    'Trigger to revisit: as needed by whoever picks it up',
    'Trigger: someday when there is capacity',
  ])('rejects the vague %s', (line) => {
    expect(checkTriggerLabel(line).kind).toBe('vague')
  })

  it('rejects a value under 12 non-space characters as too short', () => {
    expect(checkTriggerLabel('Trigger to revisit: DW-5')).toEqual({
      kind: 'short',
      value: 'DW-5',
    })
  })

  it('returns none when the line has no label', () => {
    expect(checkTriggerLabel('status: open — before Story 60.3 ships, re-run the harness')).toEqual(
      { kind: 'none' }
    )
  })
})

describe('findTriggerViolations (AC-5)', () => {
  it('passes the canonical form and closed entries without a trigger', () => {
    expect(
      messages(
        entry('1', `status: open — ${TRIGGER}`) +
          entry('2', 'status: done 2026-09-01') +
          entry('3', 'status: closed.')
      )
    ).toEqual([])
  })

  it('flags an open entry with no label at its status line (DW-315 prose is not a label)', () => {
    const content = entry('315', 'origin: x', 'status: open — before Story 60.3 ships, re-run it')
    expect(findTriggerViolations(content)).toEqual([
      { line: 4, message: 'DW-315 is open but names no revisit trigger' },
    ])
  })

  it('flags punctuated open tokens (bmad-loop reads them as not-open), even with a trigger', () => {
    for (const token of ['open.', 'open,', 'open;']) {
      expect(messages(entry('343', `status: ${token} ${TRIGGER}`))).toEqual([
        `DW-343: status token "${token}" reads as not-open to bmad-loop; write "status: open — ..."`,
      ])
    }
  })

  it('accepts "open —", "open (" and bare "open" tokens', () => {
    expect(messages(entry('1', `status: open — ${TRIGGER}`))).toEqual([])
    expect(messages(entry('1', `status: open (item 1 done). ${TRIGGER}`))).toEqual([])
    expect(messages(entry('1', BARE_OPEN, TRIGGER))).toEqual([])
  })

  it('does not check punctuation on closed tokens', () => {
    expect(messages(entry('1', 'status: done. fixed in abc'))).toEqual([])
  })

  it('reports vague and short triggers with their value', () => {
    expect(messages(entry('7', 'status: open — Trigger to revisit: TBD'))).toEqual([
      'DW-7 has a vague trigger "TBD"',
    ])
    expect(messages(entry('8', 'status: open — Trigger to revisit: DW-5'))).toEqual([
      'DW-8 has a too-short trigger "DW-5" (under 12 non-space characters)',
    ])
  })

  it('passes when any body line carries a valid trigger after a vague one', () => {
    expect(
      messages(entry('9', 'status: open — Trigger: TBD', `update (2026-09-28): ${TRIGGER}`))
    ).toEqual([])
  })

  it('flags more than one status line, unknown words and a missing status line', () => {
    expect(
      messages(entry('271', `status: open — ${TRIGGER}`, 'reason: r', `status: open — ${TRIGGER}`))
    ).toEqual(['DW-271 has 2 status: lines (:3 and :5); keep one'])
    expect(messages(entry('5', 'status: opne'))).toEqual(['DW-5: unknown status "opne"'])
    expect(findTriggerViolations(entry('6', 'reason: r'))).toEqual([
      { line: 1, message: 'DW-6: no status: line' },
    ])
  })

  it('ignores a label inside a fenced block within the body', () => {
    expect(messages(entry('1', 'status: open — see below', '```', TRIGGER, '```'))).toEqual([
      DW1_NO_TRIGGER,
    ])
  })

  it("never lets the next entry's trigger satisfy this one", () => {
    expect(messages(entry('1', OPEN_X) + entry('2', `status: open — ${TRIGGER}`))).toEqual([
      DW1_NO_TRIGGER,
    ])
  })

  it('reads a status line above a flat source_spec bullet, and stops at a bullet below it', () => {
    expect(
      messages(
        `### DW-1: t\n- source_spec: a.md\nstatus: open — x\n- source_spec: b.md\n${TRIGGER}\n`
      )
    ).toEqual([DW1_NO_TRIGGER])
  })

  it('parses variant IDs through the shared heading parser', () => {
    expect(messages(entry('23.2-1', BARE_OPEN))).toEqual([
      'DW-23.2-1 is open but names no revisit trigger',
    ])
  })

  it('counts exactly one violation for two merged branches appending entries (43-11 AC-4 case)', () => {
    const content =
      '## Deferred from: story A\n\n' +
      entry('400', `status: open — ${TRIGGER}`) +
      '## Deferred from: story B\n\n' +
      entry('401', 'status: open — waiting')
    expect(messages(content)).toEqual(['DW-401 is open but names no revisit trigger'])
  })

  it('gives the same results for CRLF input', () => {
    const lf = entry('1', 'status: open.') + entry('2', `status: open — ${TRIGGER}`)
    expect(findTriggerViolations(lf.replaceAll('\n', '\r\n'))).toEqual(findTriggerViolations(lf))
  })
})

describe('scanDeferredWorkTriggers', () => {
  it('counts entries and open entries', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      LEDGER_PATH,
      entry('1', `status: open — ${TRIGGER}`) + entry('2', 'status: done')
    )
    expect(scanDeferredWorkTriggers(root)).toMatchObject({
      entryCount: 2,
      openCount: 1,
      violations: [],
    })
  })
})

describe('check-deferred-work-triggers CLI (AC-6)', () => {
  it('(i) prints SKIPPED, not OK, when deferred-work.md is absent', () => {
    const root = makeFixtureRoot()
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(0)
    expect(run.stdout).toContain(
      `check-deferred-work-triggers: SKIPPED — ${LEDGER_PATH} not found (private overlay not attached)`
    )
    expect(run.stdout).not.toContain('— OK')
  })

  it('(ii) prints SKIPPED for a dangling overlay symlink', () => {
    const root = makeFixtureRoot()
    writeFixtureSymlink(root, LEDGER_PATH, '/nonexistent/deferred-work.md')
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('SKIPPED')
    expect(run.stdout).toContain('dangling')
  })

  it('(iii) is FATAL when the ledger path is a directory', () => {
    const root = makeFixtureRoot()
    writeFixtureDir(root, LEDGER_PATH)
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('FATAL')
  })

  it('(iv) prints OK on a clean ledger, including an empty one', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      LEDGER_PATH,
      entry('1', `status: open — ${TRIGGER}`) + entry('2', 'status: done')
    )
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(0)
    expect(run.stdout).toBe(
      'check-deferred-work-triggers: 2 DW entries, 1 open, all name a revisit trigger — OK\n'
    )

    const empty = makeFixtureRoot()
    writeFixture(empty, LEDGER_PATH, '')
    expect(runScriptCli(SCRIPT, empty).stdout).toContain('0 DW entries, 0 open')
  })

  it('(v) is FATAL on stderr with repo-relative lines and a Fix paragraph', () => {
    const root = makeFixtureRoot()
    writeFixture(root, LEDGER_PATH, entry('2', 'status: open.') + entry('1', OPEN_X))
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(1)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain('FATAL:')
    expect(run.stderr).toContain(
      `  - ${LEDGER_PATH}:3: DW-2: status token "open." reads as not-open to bmad-loop`
    )
    expect(run.stderr).toContain(`  - ${LEDGER_PATH}:3: DW-2 is open but names no revisit trigger`)
    expect(run.stderr).toContain(`  - ${LEDGER_PATH}:7: DW-1 is open but names no revisit trigger`)
    expect(run.stderr.indexOf(':3:')).toBeLessThan(run.stderr.indexOf(':7:'))
    expect(run.stderr).toContain('Fix:')
    expect(run.stderr).toContain('status: open — Trigger to revisit:')
    expect(run.stderr).not.toContain(root)
  })
})
