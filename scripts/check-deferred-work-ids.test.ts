import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanDeferredWorkIds } from './check-deferred-work-ids.js'
import {
  runScriptCli,
  useFixtureRoots,
  writeFixture,
  writeFixtureSymlink,
} from './lib/fixture-test-helpers.js'
import { trustedGit } from './lib/trusted-executable.js'

const ARTIFACTS_DIR = '_bmad-output/implementation-artifacts'
const LEDGER_PATH = `${ARTIFACTS_DIR}/deferred-work.md`
const SCRIPT = 'scripts/check-deferred-work-ids.ts'

const makeFixtureRoot = useFixtureRoots('deferred-work-ids-', [ARTIFACTS_DIR])

function scanLedger(content: string) {
  const root = makeFixtureRoot()
  writeFixture(root, LEDGER_PATH, content)
  return scanDeferredWorkIds(root)
}

describe('scanDeferredWorkIds (Story 43.11 AC-4)', () => {
  it('flags a DW ID declared twice (the DW-276 Finding 2 case) with both lines', () => {
    const result = scanLedger(
      '## Deferred from: epic-20 round-4 retro (2026-09-21)\n\n' +
        '### DW-276: Two accepted, low-severity 20-8 code-review trade-offs\n\n' +
        '## Deferred from: Story 43.2 implementation (2026-09-22)\n\n' +
        '### DW-276: `packages/api-contract-tests` has no end-to-end coverage\n'
    )
    expect(result).toEqual({
      headingCount: 2,
      duplicates: [{ id: 'DW-276', spellings: ['DW-276'], lines: [3, 7] }],
      nonStandardLevels: [],
    })
  })

  it.each([
    ['variant IDs', '### DW-24:\n### DW-24-1:\n### DW-24-5-1:\n'],
    ['51 vs 151', '### DW-51:\n### DW-151:\n'],
    ['12 vs 12a', '### DW-12:\n### DW-12a:\n'],
    ['a fenced quoted duplicate', '### DW-276: a\n```markdown\n### DW-276: quoted\n```\n'],
    ['a ~~~ fenced duplicate', '### DW-276: a\n~~~\n### DW-276: quoted\n~~~\n'],
    ['an unclosed fence', '### DW-276: a\n```\n### DW-276: b\n'],
    ['non-headings', '###DW-5: a\n### dw-5: b\n### DW-5: c\n'],
    ['numeric gaps', '### DW-1:\n### DW-3:\n'],
    ['dash look-alikes', '### DW-276:\n### DW\u2013276:\n### DW\u2014276:\n'],
  ])('passes: %s', (_name, content) => {
    const result = scanLedger(content)
    expect(result.duplicates).toEqual([])
    expect(result.nonStandardLevels).toEqual([])
  })

  it('compares case-insensitively and ignoring leading zeros, keeping both raw spellings', () => {
    expect(scanLedger('### DW-12a:\n### DW-12A:\n').duplicates).toEqual([
      { id: 'DW-12a', spellings: ['DW-12a', 'DW-12A'], lines: [1, 2] },
    ])
    expect(scanLedger('### DW-0276:\n### DW-276:\n').duplicates).toEqual([
      { id: 'DW-0276', spellings: ['DW-0276', 'DW-276'], lines: [1, 2] },
    ])
  })

  it('treats a colon-less title and a colon title as the same ID', () => {
    expect(scanLedger('### DW-5 No colon title\n### DW-5: With colon\n').duplicates).toHaveLength(1)
  })

  it('reads an end-of-line ID with no colon', () => {
    expect(scanLedger('### DW-342\n').headingCount).toBe(1)
  })

  it('flags a DW heading at a non-### level, and still counts it toward duplicates', () => {
    expect(scanLedger('#### DW-9: deep\n').nonStandardLevels).toEqual([
      { id: 'DW-9', line: 1, level: 4 },
    ])
    const both = scanLedger('#### DW-9: deep\n### DW-9: normal\n')
    expect(both.nonStandardLevels).toHaveLength(1)
    expect(both.duplicates).toEqual([{ id: 'DW-9', spellings: ['DW-9'], lines: [1, 2] }])
  })

  it('reports 3+ occurrences with every line', () => {
    expect(scanLedger('### DW-1:\n### DW-1:\n### DW-1:\n').duplicates[0]?.lines).toEqual([1, 2, 3])
  })

  it('an empty ledger has 0 headings and no violations', () => {
    expect(scanLedger('')).toEqual({ headingCount: 0, duplicates: [], nonStandardLevels: [] })
  })
})

describe('check-deferred-work-ids CLI (Story 43.11 AC-4 report + AC-7 SKIPPED)', () => {
  it('prints the duplicate FATAL block with path:line list and the Fix line, exit 1', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      LEDGER_PATH,
      '## a\n\n### DW-276: a\n\n## b\n\n### DW-276: b\n\n## c\n\n### DW-0276: c\n'
    )
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(1)
    expect(run.stderr).toContain(
      'FATAL: deferred-work.md declares the same DW ID more than once (epic-43 retro Finding 2):\n' +
        `  - DW-276 / DW-0276: ${LEDGER_PATH}:3, :7 and :11\n`
    )
    expect(run.stderr).toContain(
      'Fix: renumber the NEWER entry to the next free ID (`pnpm next-dw-id --fetch`), add a ' +
        '`renumbered: originally filed as DW-276 ...` line to it, and update every reference ' +
        '(story files, sprint-status.yaml comments, other DW entries).'
    )
    expect(run.stdout).not.toContain('OK')
  })

  it('prints the non-standard-level FATAL with path:line, exit 1', () => {
    const root = makeFixtureRoot()
    writeFixture(root, LEDGER_PATH, '## a\n#### DW-9: deep\n')
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(1)
    expect(run.stderr).toContain(`  - ${LEDGER_PATH}:2: DW-9 is a level-4 heading (####)`)
  })

  it('prints OK with the heading count on a clean ledger', () => {
    const root = makeFixtureRoot()
    writeFixture(root, LEDGER_PATH, '### DW-1: a\n### DW-2: b\n')
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(0)
    expect(run.stdout).toBe('check-deferred-work-ids: 2 DW entry headings, all IDs unique — OK\n')
  })

  it('prints SKIPPED (never OK) when deferred-work.md is absent', () => {
    const root = makeFixtureRoot()
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(0)
    expect(run.stdout).toBe(
      `check-deferred-work-ids: SKIPPED — ${LEDGER_PATH} not found (private overlay not attached); nothing checked\n`
    )
  })

  it('prints SKIPPED with "dangling" when deferred-work.md is a dangling overlay symlink', () => {
    const root = makeFixtureRoot()
    writeFixtureSymlink(root, LEDGER_PATH, '/nonexistent/private/deferred-work.md')
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('SKIPPED')
    expect(run.stdout).toContain(
      'dangling overlay symlink -> /nonexistent/private/deferred-work.md'
    )
  })
})

describe('AC-4 edge case 15 — why git alone never catches a DW collision', () => {
  it('two branches allocating the same ID merge without a textual conflict; the scanner flags it', () => {
    const repo = mkdtempSync(join(tmpdir(), 'dw-merge-race-'))
    const git = (...args: string[]) =>
      trustedGit(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
    try {
      const ledger = join(repo, LEDGER_PATH)
      writeFixture(
        repo,
        LEDGER_PATH,
        '# Deferred Work\n\n## Deferred from: story A\n\n### DW-340: a\n\n' +
          'filler 1\nfiller 2\nfiller 3\nfiller 4\n\n## Deferred from: story B\n\n### DW-341: b\n'
      )
      git('init', '-q', '-b', 'main')
      git('add', '.')
      git('commit', '-q', '-m', 'base')

      git('checkout', '-q', '-b', 'branch-a')
      writeFileSync(ledger, `${readFileSync(ledger, 'utf-8')}\n### DW-342: A\n`)
      git('commit', '-q', '-am', 'A allocates DW-342 at the end')

      git('checkout', '-q', 'main')
      git('checkout', '-q', '-b', 'branch-b')
      writeFileSync(
        ledger,
        readFileSync(ledger, 'utf-8').replace('### DW-340: a\n', '### DW-340: a\n\n### DW-342: B\n')
      )
      git('commit', '-q', '-am', 'B allocates DW-342 higher up')

      git('merge', '-q', '--no-edit', 'branch-a')

      const { duplicates } = scanDeferredWorkIds(repo)
      expect(duplicates).toHaveLength(1)
      expect(duplicates[0]?.id).toBe('DW-342')
      expect(duplicates[0]?.lines).toHaveLength(2)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('scanDeferredWorkIds against the real repository', () => {
  it('has no duplicate DW ID and no non-standard heading level in the current ledger', () => {
    const { duplicates, nonStandardLevels } = scanDeferredWorkIds(process.cwd())
    expect(duplicates).toEqual([])
    expect(nonStandardLevels).toEqual([])
  })
})
