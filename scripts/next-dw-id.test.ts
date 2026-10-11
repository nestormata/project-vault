import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { allocateNextDwId, reserveDwIds } from './next-dw-id.js'
import {
  runScriptCli,
  useFixtureRoots,
  writeFixture,
  writeFixtureSymlink,
} from './lib/fixture-test-helpers.js'
import { formatReservationStub, parseReservations, RESERVED_SECTION } from './lib/dw-reservation.js'
import { parseDwHeadings } from './lib/deferred-work-ledger.js'
import { trustedGit } from './lib/trusted-executable.js'

const ARTIFACTS_DIR = '_bmad-output/implementation-artifacts'
const LEDGER_PATH = `${ARTIFACTS_DIR}/deferred-work.md`
const SCRIPT = 'scripts/next-dw-id.ts'
const PRIVATE_LEDGER_REL = 'ledger/deferred-work.md'
const REMOTE_REF = 'refs/remotes/origin/feature/y'

const makeFixtureRoot = useFixtureRoots('next-dw-id-', [ARTIFACTS_DIR])

function ledgerUpTo(max: number): string {
  const entries = Array.from({ length: max }, (_, i) => `### DW-${i + 1}: entry ${i + 1}\n`)
  return `# Deferred Work\n\n## Deferred from: x\n\n${entries.join('\n')}`
}

function gitIn(repo: string) {
  return (...args: string[]) =>
    trustedGit(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
}

/** A fixture root that is itself a git repo whose `main` holds DW-1..DW-341. */
function makeLedgerRepo(): { root: string; git: (...args: string[]) => string; ledger: string } {
  const root = makeFixtureRoot()
  const git = gitIn(root)
  writeFixture(root, LEDGER_PATH, ledgerUpTo(341))
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('commit', '-q', '-m', 'base')
  return { root, git, ledger: join(root, LEDGER_PATH) }
}

function appendEntry(ledger: string, heading: string): void {
  writeFileSync(ledger, `${readFileSync(ledger, 'utf-8')}\n${heading}\n`)
}

function commitOnBranch(
  git: (...args: string[]) => string,
  ledger: string,
  branch: string,
  heading: string
): void {
  git('checkout', '-q', '-b', branch)
  appendEntry(ledger, heading)
  git('commit', '-q', '-am', `add ${heading}`)
  git('checkout', '-q', 'main')
}

describe('allocateNextDwId (Story 43.11 AC-5)', () => {
  it('reads every local branch, not just the working tree', () => {
    const { root, git, ledger } = makeLedgerRepo()
    commitOnBranch(git, ledger, 'feature/x', '### DW-342: on a branch')
    expect(allocateNextDwId(root)).toEqual({
      next: 'DW-343',
      max: 342,
      source: 'refs/heads/feature/x',
      warnings: [],
    })
  })

  it('reads remote-tracking refs and skips the symbolic origin/HEAD', () => {
    const { root, git, ledger } = makeLedgerRepo()
    commitOnBranch(git, ledger, 'tmp', '### DW-350: remote only')
    git('update-ref', REMOTE_REF, 'tmp')
    git('branch', '-q', '-D', 'tmp')
    git('symbolic-ref', 'refs/remotes/origin/HEAD', REMOTE_REF)
    expect(allocateNextDwId(root)).toMatchObject({
      next: 'DW-351',
      source: REMOTE_REF,
    })
  })

  it('counts an uncommitted working-tree entry', () => {
    const { root, ledger } = makeLedgerRepo()
    appendEntry(ledger, '### DW-345: uncommitted')
    expect(allocateNextDwId(root)).toMatchObject({ next: 'DW-346', source: 'working tree' })
  })

  it('ignores variant IDs for numbering', () => {
    const { root, ledger } = makeLedgerRepo()
    appendEntry(ledger, '### DW-23.2-99: variant')
    appendEntry(ledger, '### DW-400-1: variant')
    expect(allocateNextDwId(root).next).toBe('DW-342')
  })

  it('ignores a heading inside a fenced code block on a branch (same parser as the guard)', () => {
    const { root, git, ledger } = makeLedgerRepo()
    commitOnBranch(git, ledger, 'fenced', '```markdown\n### DW-400: quoted example\n```')
    expect(allocateNextDwId(root).next).toBe('DW-342')
  })

  it('normalizes leading zeros (DW-0350 counts as 350)', () => {
    const { root, git, ledger } = makeLedgerRepo()
    commitOnBranch(git, ledger, 'zeros', '### DW-0350: leading zero')
    expect(allocateNextDwId(root).next).toBe('DW-351')
  })

  it('follows the overlay symlink into the private repo that holds the ledger', () => {
    const privateRepo = makeFixtureRoot()
    const git = gitIn(privateRepo)
    const privateLedger = join(privateRepo, PRIVATE_LEDGER_REL)
    writeFixture(privateRepo, PRIVATE_LEDGER_REL, ledgerUpTo(10))
    git('init', '-q', '-b', 'main')
    git('add', '.')
    git('commit', '-q', '-m', 'base')
    commitOnBranch(git, privateLedger, 'feature/z', '### DW-11: private branch')

    const publicRoot = makeFixtureRoot()
    writeFixtureSymlink(publicRoot, LEDGER_PATH, privateLedger)
    expect(allocateNextDwId(publicRoot)).toMatchObject({
      next: 'DW-12',
      source: 'refs/heads/feature/z',
    })
  })

  it('warns and uses the working-tree file when it is not inside a git repository', () => {
    const root = makeFixtureRoot()
    writeFixture(root, LEDGER_PATH, ledgerUpTo(3))
    const result = allocateNextDwId(root)
    expect(result.next).toBe('DW-4')
    expect(result.warnings).toEqual(['not a git repository; using the working-tree file only'])
  })

  it('warns on a failed --fetch and still allocates from local refs', () => {
    const { root, git } = makeLedgerRepo()
    git('remote', 'add', 'origin', join(root, 'does-not-exist.git'))
    const result = allocateNextDwId(root, { fetch: true })
    expect(result.next).toBe('DW-342')
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/^git fetch --all --prune failed/)
  })

  it('skips a ref that predates the ledger silently (the normal case, no warning)', () => {
    const { root, git } = makeLedgerRepo()
    git('checkout', '-q', '--orphan', 'no-ledger')
    git('rm', '-rq', '--cached', '.')
    git('commit', '-q', '--allow-empty', '-m', 'no ledger here')
    git('checkout', '-q', '-f', 'main')
    expect(allocateNextDwId(root)).toMatchObject({ next: 'DW-342', warnings: [] })
  })

  it('code review: warns (never silently skips) when a ref holds the ledger but git cannot read it', () => {
    const { root, git, ledger } = makeLedgerRepo()
    commitOnBranch(git, ledger, 'feature/corrupt', '### DW-900: unreadable')
    const blob = git('rev-parse', `feature/corrupt:${LEDGER_PATH}`).trim()
    rmSync(join(root, '.git/objects', blob.slice(0, 2), blob.slice(2)))
    const result = allocateNextDwId(root)
    expect(result.next).toBe('DW-342')
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(
      /^could not read .*deferred-work\.md at refs\/heads\/feature\/corrupt \(.+\); the next ID may collide/
    )
  })

  it('starts at DW-1 when the ledger has no plain numeric ID', () => {
    const root = makeFixtureRoot()
    writeFixture(root, LEDGER_PATH, '# Deferred Work\n')
    expect(allocateNextDwId(root)).toMatchObject({ next: 'DW-1', max: 0, source: undefined })
  })

  it('race documentation: two calls with no intervening commit print the same ID', () => {
    const { root } = makeLedgerRepo()
    expect(allocateNextDwId(root).next).toBe(allocateNextDwId(root).next)
  })

  it('throws (never allocates) when deferred-work.md is absent', () => {
    const root = makeFixtureRoot()
    expect(() => allocateNextDwId(root)).toThrow(/deferred-work\.md not found/)
  })
})

describe('next-dw-id CLI (Story 43.11 AC-5)', () => {
  it('prints the ID on the first stdout line and its source on the second', () => {
    const { root, git, ledger } = makeLedgerRepo()
    commitOnBranch(git, ledger, 'feature/x', '### DW-342: on a branch')
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(0)
    expect(run.stdout).toBe(
      'DW-343\nmax DW-342 seen on refs/heads/feature/x\n' +
        'hint: add --reserve to claim this ID in the ledger now (66-19)\n'
    )
  })

  it('prints warnings to stderr only, keeping stdout machine-friendly', () => {
    const root = makeFixtureRoot()
    writeFixture(root, LEDGER_PATH, ledgerUpTo(3))
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(0)
    expect(run.stdout.split('\n')[0]).toBe('DW-4')
    expect(run.stderr).toContain('WARN: next-dw-id: not a git repository')
  })

  it('exits 1 without printing an ID when deferred-work.md is absent', () => {
    const root = makeFixtureRoot()
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(1)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain('deferred-work.md not found')
  })
})

const NOW = new Date('2026-10-11T12:00:00.000Z')
const STAMP = NOW.toISOString()

function ledgerHeadings(root: string): string[] {
  return parseDwHeadings(readFileSync(join(root, LEDGER_PATH), 'utf-8')).map((h) => h.id)
}

describe('reserveDwIds (Story 66-19 AC-1)', () => {
  it('two back-to-back reservations return DW-N and DW-N+1 (the second sees the first stub)', () => {
    const { root } = makeLedgerRepo()
    const first = reserveDwIds(root, { story: '66-19', now: NOW })
    const second = reserveDwIds(root, { story: '66-20', now: NOW })
    expect(first.ids).toEqual(['DW-342'])
    expect(second.ids).toEqual(['DW-343'])
    expect(ledgerHeadings(root).slice(-2)).toEqual(['DW-342', 'DW-343'])
  })

  it('writes the stub under a Reserved section created once at the end of the file', () => {
    const { root, ledger } = makeLedgerRepo()
    reserveDwIds(root, { story: '66-19', now: NOW })
    reserveDwIds(root, { story: '66-19', now: NOW })
    const content = readFileSync(ledger, 'utf-8')
    expect(content.split(RESERVED_SECTION)).toHaveLength(2)
    expect(
      content.endsWith(
        `${formatReservationStub(342, '66-19', NOW)}\n${formatReservationStub(343, '66-19', NOW)}`
      )
    ).toBe(true)
    expect(parseReservations(content).map((r) => [r.id, r.story, r.timestampText])).toEqual([
      ['DW-342', '66-19', STAMP],
      ['DW-343', '66-19', STAMP],
    ])
  })

  it('--count 3 reserves three consecutive IDs in one append', () => {
    const { root } = makeLedgerRepo()
    expect(reserveDwIds(root, { story: '66-19', count: 3, now: NOW }).ids).toEqual([
      'DW-342',
      'DW-343',
      'DW-344',
    ])
    expect(ledgerHeadings(root).slice(-3)).toEqual(['DW-342', 'DW-343', 'DW-344'])
  })

  it('adds the missing trailing newline before the stub', () => {
    const root = makeFixtureRoot()
    writeFixture(root, LEDGER_PATH, '# Deferred Work\n\n### DW-1: a\nstatus: done')
    reserveDwIds(root, { story: '66-19', now: NOW })
    const content = readFileSync(join(root, LEDGER_PATH), 'utf-8')
    expect(content).toContain('status: done\n\n## Reserved (not yet written)')
    expect(ledgerHeadings(root)).toEqual(['DW-1', 'DW-2'])
  })

  it('re-adds the section header when the last ## section is not the Reserved one', () => {
    const { root, ledger } = makeLedgerRepo()
    reserveDwIds(root, { story: '66-19', now: NOW })
    writeFileSync(
      ledger,
      `${readFileSync(ledger, 'utf-8')}\n## Deferred from: later\n\n### DW-400: later\n`
    )
    reserveDwIds(root, { story: '66-19', now: NOW })
    expect(readFileSync(ledger, 'utf-8').split(RESERVED_SECTION)).toHaveLength(3)
  })

  it('leaves no lock file behind', () => {
    const { root } = makeLedgerRepo()
    reserveDwIds(root, { story: '66-19', now: NOW })
    expect(existsSync(join(root, `${LEDGER_PATH}.lock`))).toBe(false)
  })

  it.each([
    ['an empty ledger', ''],
    ['a whitespace-only ledger', '\n\n'],
  ])('refuses %s instead of starting at DW-1, writing nothing', (_n, content) => {
    const root = makeFixtureRoot()
    writeFixture(root, LEDGER_PATH, content)
    expect(() => reserveDwIds(root, { story: '66-19', now: NOW })).toThrow(/empty/)
    expect(readFileSync(join(root, LEDGER_PATH), 'utf-8')).toBe(content)
  })

  it('fails closed (writes nothing) when the ledger is missing', () => {
    const root = makeFixtureRoot()
    expect(() => reserveDwIds(root, { story: '66-19', now: NOW })).toThrow(
      /deferred-work\.md not found/
    )
    expect(existsSync(join(root, LEDGER_PATH))).toBe(false)
  })

  it.each(['abc', '66-19\n### DW-1: injected', '66-19 #x', ''])(
    'rejects the invalid story key %j with nothing written',
    (story) => {
      const { root, ledger } = makeLedgerRepo()
      const before = readFileSync(ledger, 'utf-8')
      expect(() => reserveDwIds(root, { story, now: NOW })).toThrow(/story key/)
      expect(readFileSync(ledger, 'utf-8')).toBe(before)
    }
  )

  it.each([0, -1, 1.5, 101])('rejects the invalid count %j', (count) => {
    const { root, ledger } = makeLedgerRepo()
    const before = readFileSync(ledger, 'utf-8')
    expect(() => reserveDwIds(root, { story: '66-19', count, now: NOW })).toThrow(/count/)
    expect(readFileSync(ledger, 'utf-8')).toBe(before)
  })

  it('writes through the overlay symlink into the private ledger, keeping the link', () => {
    const privateRepo = makeFixtureRoot()
    const privateLedger = join(privateRepo, PRIVATE_LEDGER_REL)
    writeFixture(privateRepo, PRIVATE_LEDGER_REL, ledgerUpTo(10))
    const publicRoot = makeFixtureRoot()
    writeFixtureSymlink(publicRoot, LEDGER_PATH, privateLedger)
    expect(reserveDwIds(publicRoot, { story: '66-19', now: NOW }).ids).toEqual(['DW-11'])
    expect(readFileSync(privateLedger, 'utf-8')).toContain('### DW-11: RESERVED 66-19')
    expect(existsSync(join(privateRepo, `${PRIVATE_LEDGER_REL}.lock`))).toBe(false)
  })
})

describe('next-dw-id --reserve CLI (Story 66-19 AC-1)', () => {
  it('prints the reserved IDs one per line, then the max line, with the commit-now hint on stderr', () => {
    const { root } = makeLedgerRepo()
    const run = runScriptCli(SCRIPT, root, ['--reserve', '--count', '2', '--story', '66-19'])
    expect(run.status).toBe(0)
    expect(run.stdout).toBe('DW-342\nDW-343\nmax DW-341 seen on working tree\n')
    expect(run.stderr).toContain('commit the stub hunk now (own hunk only)')
    expect(ledgerHeadings(root).slice(-2)).toEqual(['DW-342', 'DW-343'])
  })

  it('keeps line 1 of stdout as the first ID for a single reservation', () => {
    const { root } = makeLedgerRepo()
    const run = runScriptCli(SCRIPT, root, ['--reserve'])
    expect(run.stdout.split('\n')[0]).toBe('DW-342')
  })

  it('exits 1 and writes nothing for an invalid story key or an empty ledger', () => {
    const { root, ledger } = makeLedgerRepo()
    const before = readFileSync(ledger, 'utf-8')
    const badStory = runScriptCli(SCRIPT, root, ['--reserve', '--story', 'nope'])
    expect(badStory.status).toBe(1)
    expect(badStory.stdout).toBe('')
    expect(badStory.stderr).toContain('FATAL: next-dw-id:')
    expect(readFileSync(ledger, 'utf-8')).toBe(before)

    const emptyRoot = makeFixtureRoot()
    writeFixture(emptyRoot, LEDGER_PATH, '')
    const emptyRun = runScriptCli(SCRIPT, emptyRoot, ['--reserve', '--story', '66-19'])
    expect(emptyRun.status).toBe(1)
    expect(emptyRun.stdout).toBe('')
    expect(readFileSync(join(emptyRoot, LEDGER_PATH), 'utf-8')).toBe('')
  })

  it('two concurrent --reserve processes get distinct IDs and no duplicate heading (structural)', async () => {
    const { root } = makeLedgerRepo()
    const repositoryRoot = join(import.meta.dirname, '..')
    const loader = join(repositoryRoot, 'node_modules/tsx/dist/esm/index.mjs')
    const script = join(repositoryRoot, SCRIPT)
    const runOne = (story: string) =>
      new Promise<{ code: number | null; stdout: string }>((resolveRun) => {
        const child = spawn(
          process.execPath,
          ['--import', loader, script, '--reserve', '--story', story],
          { cwd: root }
        )
        let stdout = ''
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
        child.on('close', (code) => resolveRun({ code, stdout }))
      })
    const runs = await Promise.all(Array.from({ length: 6 }, (_, i) => runOne(`66-${i + 1}`)))
    expect(runs.map((r) => r.code)).toEqual([0, 0, 0, 0, 0, 0])
    const ids = runs.map((r) => r.stdout.split('\n')[0])
    expect(new Set(ids)).toEqual(
      new Set(['DW-342', 'DW-343', 'DW-344', 'DW-345', 'DW-346', 'DW-347'])
    )
    const headings = ledgerHeadings(root)
    expect(new Set(headings).size).toBe(headings.length)
  })
})

describe('reserveDwIds --fetch (66-19 code review)', () => {
  it('fetches outside the lock, reports a failed fetch once, and still reserves the next ID', () => {
    const { root, git } = makeLedgerRepo()
    git('remote', 'add', 'origin', join(root, 'does-not-exist.git'))
    const result = reserveDwIds(root, { fetch: true, story: '66-19', now: NOW })
    expect(result.ids).toEqual(['DW-342'])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/^git fetch --all --prune failed/)
  })
})
