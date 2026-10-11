import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { runScriptCli, useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'
import { runWarnFiredDwTriggers } from './warn-fired-dw-triggers.js'

const ARTIFACTS_DIR = '_bmad-output/implementation-artifacts'
const LEDGER_PATH = `${ARTIFACTS_DIR}/deferred-work.md`
const SCRIPT = 'scripts/warn-fired-dw-triggers.ts'
const OLD_NAME = 'src/old-name.ts'
const EXAMPLE_GUARD = 'scripts/example-guard.ts'

const makeFixtureRoot = useFixtureRoots('warn-fired-dw-triggers-', [ARTIFACTS_DIR])

const openEntry = (n: number, trigger: string) =>
  `### DW-${n}: invented title\n\nlocation: elsewhere/file.ts\nstatus: open — Trigger to revisit: ${trigger}\n\n`

function run(root: string, argv: string[], env: Record<string, string | undefined> = {}): string[] {
  const lines: string[] = []
  runWarnFiredDwTriggers(argv, { rootDir: root, env, out: (line) => lines.push(line) })
  return lines
}

function git(root: string, ...args: string[]): void {
  execFileSync('/usr/bin/git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd: root,
    stdio: 'pipe',
  })
}

function makeRepo(ledger: string): string {
  const root = makeFixtureRoot()
  writeFixture(root, LEDGER_PATH, ledger)
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'init')
  return root
}

describe('warn-fired-dw-triggers --files (AC-4, AC-8)', () => {
  it('warns once for the DW-271-shaped case and keeps exit 0', () => {
    const root = makeFixtureRoot()
    writeFixture(root, LEDGER_PATH, openEntry(9001, `the next change to \`${EXAMPLE_GUARD}\`.`))
    const cli = runScriptCli(SCRIPT, root, ['--files', EXAMPLE_GUARD, 'README.md'])
    expect(cli.status).toBe(0)
    const lines = cli.stdout.trimEnd().split('\n')
    expect(lines[0]).toBe('WARN: 1 open deferred-work entries name a file changed in this diff:')
    expect(lines[1]).toBe(`  DW-9001 (deferred-work.md:1) -> ${EXAMPLE_GUARD}`)
    expect(lines).toHaveLength(3)
    expect(lines[2]).toMatch(/resolve|update|re-trigger/)
  })

  it('stays silent about a similarly prefixed file', () => {
    const root = makeFixtureRoot()
    writeFixture(root, LEDGER_PATH, openEntry(9001, `\`${EXAMPLE_GUARD}\``))
    expect(run(root, ['--files', 'scripts/example-guard.test.ts'])).toEqual([
      'warn-fired-dw-triggers: no open deferred-work trigger names a changed file.',
    ])
  })

  it('handles directory and glob triggers', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      LEDGER_PATH,
      openEntry(1, '`apps/web/guards/`') + openEntry(2, '`packages/kit/**/*.test.ts`')
    )
    const lines = run(root, ['--files', 'apps/web/guards/a.ts', 'packages/kit/src/b.test.ts'])
    expect(lines[0]).toContain('WARN: 2 open')
    expect(lines).toContain('  DW-1 (deferred-work.md:1) -> apps/web/guards/a.ts')
    expect(lines).toContain('  DW-2 (deferred-work.md:6) -> packages/kit/src/b.test.ts')
  })

  it('ignores closed entries, location text and fenced DW-looking headings', () => {
    const root = makeFixtureRoot()
    const ledger =
      `### DW-1: closed\n\nstatus: done — Trigger to revisit: \`a/closed.ts\` again.\n\n` +
      `### DW-2: location only\n\nlocation: a/loc.ts\nstatus: open — Trigger to revisit: story 99-9 lands.\n\n` +
      '```\n### DW-3: fenced\nstatus: open — Trigger to revisit: `a/fenced.ts` changes.\n```\n'
    writeFixture(root, LEDGER_PATH, ledger)
    expect(run(root, ['--files', 'a/closed.ts', 'a/loc.ts', 'a/fenced.ts'])).toEqual([
      'warn-fired-dw-triggers: no open deferred-work trigger names a changed file.',
    ])
  })

  it('finds a trigger on a non-status body line', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      LEDGER_PATH,
      '### DW-5: t\n\nstatus: open\nTrigger to revisit: the next edit of `lib/x.ts`.\n'
    )
    expect(run(root, ['--files', 'lib/x.ts'])[1]).toBe('  DW-5 (deferred-work.md:1) -> lib/x.ts')
  })

  it('caps the printed hits at 25 and says how many more', () => {
    const root = makeFixtureRoot()
    const ledger = Array.from({ length: 30 }, (_, i) => openEntry(i + 1, '`lib/busy.ts`')).join('')
    writeFixture(root, LEDGER_PATH, ledger)
    const lines = run(root, ['--files', 'lib/busy.ts'])
    expect(lines.filter((l) => l.startsWith('  DW-'))).toHaveLength(25)
    expect(lines).toContain('  ... and 5 more')
    expect(lines[0]).toContain('WARN: 30 open')
  })

  it('normalizes Windows separators in --files', () => {
    const root = makeFixtureRoot()
    writeFixture(root, LEDGER_PATH, openEntry(1, '`apps/web/x.ts`'))
    expect(run(root, ['--files', 'apps\\web\\x.ts'])[1]).toBe(
      '  DW-1 (deferred-work.md:1) -> apps/web/x.ts'
    )
  })
})

describe('degraded paths always exit 0 and print skipped (AC-4)', () => {
  it('no overlay', () => {
    const root = makeFixtureRoot()
    const cli = runScriptCli(SCRIPT, root, ['--files', 'a.ts'])
    expect(cli.status).toBe(0)
    expect(cli.stdout).toMatch(/^warn-fired-dw-triggers: skipped \(.+\)\n$/)
  })

  it('empty ledger file', () => {
    const root = makeFixtureRoot()
    writeFixture(root, LEDGER_PATH, '')
    const cli = runScriptCli(SCRIPT, root, ['--files', 'a.ts'])
    expect(cli.status).toBe(0)
    expect(cli.stdout).toMatch(/skipped \(/)
  })

  it('--files with no arguments', () => {
    const root = makeFixtureRoot()
    writeFixture(root, LEDGER_PATH, openEntry(1, '`a/b.ts`'))
    const cli = runScriptCli(SCRIPT, root, ['--files'])
    expect(cli.status).toBe(0)
    expect(cli.stdout).toMatch(/skipped \(no files given\)/)
  })

  it('git failure outside a repository', () => {
    const root = makeFixtureRoot()
    writeFixture(root, LEDGER_PATH, openEntry(1, '`a/b.ts`'))
    const cli = runScriptCli(SCRIPT, root)
    expect(cli.status).toBe(0)
    expect(cli.stdout).toMatch(/skipped \(git/)
  })

  it('an invalid --base ref is rejected before git runs', () => {
    const root = makeFixtureRoot()
    writeFixture(root, LEDGER_PATH, openEntry(1, '`a/b.ts`'))
    for (const base of ['--output=x', 'a b']) {
      expect(run(root, ['--base', base])).toEqual([
        'warn-fired-dw-triggers: skipped (invalid --base)',
      ])
    }
  })
})

describe('GitHub annotations (AC-9)', () => {
  it('emits one ::warning:: line per hit only under GITHUB_ACTIONS', () => {
    const root = makeFixtureRoot()
    writeFixture(root, LEDGER_PATH, openEntry(271, '`apps/api/src/main.ts`'))
    const plain = run(root, ['--files', 'apps/api/src/main.ts'])
    expect(plain.some((l) => l.startsWith('::'))).toBe(false)
    const ci = run(root, ['--files', 'apps/api/src/main.ts'], { GITHUB_ACTIONS: 'true' })
    expect(ci.filter((l) => l.startsWith('::warning'))).toEqual([
      '::warning title=Open DW trigger fired::DW-271 names apps/api/src/main.ts (deferred-work.md%3A1)',
    ])
  })

  it('escapes %, comma, colon and newline so a path cannot inject a second command', () => {
    const root = makeFixtureRoot()
    writeFixture(root, LEDGER_PATH, openEntry(1, '`a/*.ts`'))
    const nasty = 'a/%x,y:z\n::error::boom.ts'
    const ci = run(root, ['--files', nasty], { GITHUB_ACTIONS: 'true' })
    const annotations = ci.filter((l) => l.includes('::warning'))
    expect(annotations).toHaveLength(1)
    const message = (annotations[0] ?? '').slice('::warning title=Open DW trigger fired::'.length)
    expect(message).not.toMatch(/[\n\r:,]/)
    expect(message).toContain('%25x%2Cy%3Az%0A%3A%3Aerror%3A%3Aboom.ts')
    expect(ci.every((l) => !l.startsWith('::error'))).toBe(true)
  })
})

describe('git inputs (AC-10)', () => {
  it('sees committed-branch, uncommitted and untracked changes, with paths containing spaces', () => {
    const root = makeRepo(openEntry(1, '`docs/` or `src/new.ts` or `src/edit.ts`'))
    writeFixture(root, 'src/edit.ts', 'a\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'base')
    git(root, 'checkout', '-q', '-b', 'feature')
    writeFixture(root, 'src/edit.ts', 'b\n')
    writeFixture(root, 'docs/my file.md', 'x\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'work')
    writeFixture(root, 'src/new.ts', 'untracked\n')
    const lines = run(root, ['--base', 'main'])
    expect(lines[1]).toBe('  DW-1 (deferred-work.md:1) -> docs/my file.md, src/edit.ts, src/new.ts')
  })

  it('a renamed file triggers on the old path', () => {
    const root = makeRepo(openEntry(1, '`src/old-name.ts`'))
    writeFixture(root, OLD_NAME, 'content that is long enough to be detected as a rename\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'add')
    git(root, 'checkout', '-q', '-b', 'feature')
    git(root, 'mv', OLD_NAME, 'src/new-name.ts')
    git(root, 'commit', '-q', '-m', 'rename')
    expect(run(root, ['--base', 'main'])[1]).toBe('  DW-1 (deferred-work.md:1) -> src/old-name.ts')
  })

  it('a staged rename in the working tree also triggers on the old path', () => {
    const root = makeRepo(openEntry(1, '`src/old-name.ts`'))
    writeFixture(root, OLD_NAME, 'content that is long enough to be detected as a rename\n')
    git(root, 'add', '-A')
    git(root, 'commit', '-q', '-m', 'add')
    git(root, 'mv', OLD_NAME, 'src/new-name.ts')
    expect(run(root, ['--base', 'main'])[1]).toBe('  DW-1 (deferred-work.md:1) -> src/old-name.ts')
  })

  it('retries local main when origin/main is missing and no --base was given', () => {
    const root = makeRepo(openEntry(1, '`src/x.ts`'))
    writeFixture(root, 'src/x.ts', 'x\n')
    const lines = run(root, [])
    expect(lines[1]).toBe('  DW-1 (deferred-work.md:1) -> src/x.ts')
  })

  it('an explicit --base that does not exist is skipped, not retried', () => {
    const root = makeRepo(openEntry(1, '`src/x.ts`'))
    expect(run(root, ['--base', 'no-such-ref'])[0]).toMatch(
      /^warn-fired-dw-triggers: skipped \(git/
    )
  })
})
