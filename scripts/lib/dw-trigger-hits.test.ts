import { describe, expect, it } from 'vitest'
import { parseDwEntries } from './deferred-work-ledger.js'
import { findFiredTriggers } from './dw-trigger-hits.js'

const MAIN_TS = 'apps/api/src/main.ts'
const A_TS = 'scripts/a.ts'
const X_TS = 'apps/api/x.ts'
const entryText = (id: number, ...body: string[]) =>
  `### DW-${id}: invented title\n\n${body.join('\n')}\n\n`
const hits = (ledger: string, changed: string[]) =>
  findFiredTriggers(parseDwEntries(ledger), changed)
const openWith = (trigger: string) =>
  entryText(
    9001,
    'location: apps/api/src/never-matched.ts',
    `status: open — Trigger to revisit: ${trigger}`
  )

describe('findFiredTriggers (AC-1)', () => {
  const ledger = openWith(
    'the next change to `apps/api/src/lib/fatal-fault-handler.ts` or `apps/api/src/main.ts`.'
  )

  it('returns one hit for a changed file named by an open entry', () => {
    expect(hits(ledger, [MAIN_TS, 'README.md'])).toEqual([
      {
        id: 'DW-9001',
        line: 1,
        matchedPaths: [MAIN_TS],
        matchedFiles: [MAIN_TS],
      },
    ])
  })

  it('does not treat a shared prefix as a match', () => {
    expect(hits(ledger, ['apps/api/src/mail.ts'])).toEqual([])
    expect(hits(openWith('`scripts/example-guard.ts`'), ['scripts/example-guard.test.ts'])).toEqual(
      []
    )
  })

  it('ignores closed entries', () => {
    const closed = entryText(
      9002,
      'status: done — Trigger to revisit: the next change to `apps/api/src/main.ts`.'
    )
    expect(hits(closed, [MAIN_TS])).toEqual([])
  })

  it('orders hits by line and sorts and de-duplicates matched files', () => {
    const text =
      entryText(9003, 'status: open — Trigger to revisit: `b/x.ts` or `a/y.ts` or `a/y.ts`.') +
      entryText(9004, 'status: open — Trigger to revisit: `a/y.ts` is edited.')
    const result = hits(text, ['b/x.ts', 'a/y.ts', 'a/y.ts'])
    expect(result.map((h) => h.id)).toEqual(['DW-9003', 'DW-9004'])
    expect(result[0]?.matchedFiles).toEqual(['a/y.ts', 'b/x.ts'])
    expect(result[0]?.matchedPaths).toEqual(['b/x.ts', 'a/y.ts'])
  })
})

describe('which text counts as a path (AC-2, AC-3)', () => {
  it('reads paths only from the trigger value, not location or reason', () => {
    const text = entryText(
      9005,
      'location: scripts/example-guard.ts',
      'reason: touches `scripts/example-guard.ts`',
      'status: open — Trigger to revisit: a later story, 99-9.'
    )
    expect(hits(text, ['scripts/example-guard.ts'])).toEqual([])
  })

  it('finds a trigger on its own body line, and uses several trigger lines', () => {
    const text = entryText(
      9006,
      'status: open',
      'Trigger to revisit: the next change to `scripts/a.ts`.',
      'Trigger: also `scripts/b.ts`.'
    )
    expect(hits(text, ['scripts/b.ts'])[0]?.matchedFiles).toEqual(['scripts/b.ts'])
    expect(hits(text, [A_TS])[0]?.matchedFiles).toEqual([A_TS])
  })

  it('skips an open entry without a parsable trigger', () => {
    expect(hits(entryText(9007, 'status: open', 'see `scripts/a.ts`'), [A_TS])).toEqual([])
  })

  it('matches bare (non-backticked) paths and trims trailing punctuation', () => {
    const text = openWith('whenever scripts/lib/foo.ts, (or scripts/bar.sql) changes; then.')
    const [hit] = hits(text, ['scripts/lib/foo.ts', 'scripts/bar.sql'])
    expect(hit?.matchedFiles).toEqual(['scripts/bar.sql', 'scripts/lib/foo.ts'])
  })

  it('strips a trailing :line suffix', () => {
    expect(hits(openWith('`scripts/a.ts:120`'), [A_TS])).toHaveLength(1)
  })

  it('never treats story keys, versions, dates, URLs or bare words as paths', () => {
    const text = openWith(
      'story 70-3, 43-23 or release 3.32.0 on 2026-10-10, see https://example.com/a/b.ts and soon'
    )
    expect(hits(text, ['70-3', '43-23', '3.32.0', '2026-10-10', 'soon', 'a/b.ts'])).toEqual([])
  })

  it('matches a glob', () => {
    const text = openWith('`packages/composition-kit/**/*.test.ts`')
    expect(hits(text, ['packages/composition-kit/src/a/b.test.ts'])).toHaveLength(1)
    expect(hits(text, ['packages/composition-kit/src/a/b.ts'])).toEqual([])
    expect(hits(text, ['packages/composition-kit/b.test.ts'])).toHaveLength(1)
  })

  it('matches a single-segment wildcard only within one directory level', () => {
    const text = openWith('`apps/web/*.svelte`')
    expect(hits(text, ['apps/web/a.svelte'])).toHaveLength(1)
    expect(hits(text, ['apps/web/sub/a.svelte'])).toEqual([])
  })

  it('matches a trailing-slash directory', () => {
    const text = openWith('anything in `apps/web/guards/`')
    expect(hits(text, ['apps/web/guards/svelte-files.ts'])).toHaveLength(1)
    expect(hits(text, ['apps/web/guards-other/x.ts'])).toEqual([])
  })
})

describe('directory and bare-name bounds (AC-11)', () => {
  it('a single segment without a slash never matches a nested file; with a slash it does', () => {
    expect(hits(openWith('`scripts`'), ['scripts/x.ts'])).toEqual([])
    expect(hits(openWith('`scripts/`'), ['scripts/x.ts'])).toHaveLength(1)
  })

  it('a two-segment extensionless candidate is a directory', () => {
    expect(hits(openWith('`apps/web/guards`'), ['apps/web/guards/a.ts'])).toHaveLength(1)
    expect(hits(openWith('`apps/web/guards`'), ['apps/web/guardsx/a.ts'])).toEqual([])
  })

  it('a bare filename matches only the repository root file', () => {
    const text = openWith('`Makefile` changes')
    expect(hits(text, ['Makefile'])).toHaveLength(1)
    expect(hits(text, ['deploy/Makefile'])).toEqual([])
    expect(hits(openWith('`package.json`'), ['apps/api/package.json'])).toEqual([])
  })

  it('normalizes ./ prefixes and backslashes, and compares case-sensitively', () => {
    expect(hits(openWith('`./apps/api/x.ts`'), [X_TS])).toHaveLength(1)
    expect(hits(openWith('`apps/api/x.ts`'), ['./apps/api/x.ts'])).toHaveLength(1)
    expect(hits(openWith('`apps\\api\\x.ts`'), [X_TS])).toHaveLength(1)
    expect(hits(openWith('`apps/api/X.ts`'), [X_TS])).toEqual([])
  })
})
