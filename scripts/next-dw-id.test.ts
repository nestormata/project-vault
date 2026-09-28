import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { allocateNextDwId } from './next-dw-id.js'
import {
  runScriptCli,
  useFixtureRoots,
  writeFixture,
  writeFixtureSymlink,
} from './lib/fixture-test-helpers.js'
import { trustedGit } from './lib/trusted-executable.js'

const ARTIFACTS_DIR = '_bmad-output/implementation-artifacts'
const LEDGER_PATH = `${ARTIFACTS_DIR}/deferred-work.md`
const SCRIPT = 'scripts/next-dw-id.ts'
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
    const privateLedger = join(privateRepo, 'ledger/deferred-work.md')
    writeFixture(privateRepo, 'ledger/deferred-work.md', ledgerUpTo(10))
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
    expect(run.stdout).toBe('DW-343\nmax DW-342 seen on refs/heads/feature/x\n')
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
