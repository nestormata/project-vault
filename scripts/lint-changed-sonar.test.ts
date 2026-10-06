import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  addedSuppressions,
  classifyFiles,
  filesOutsideTsProjects,
  parseArgs,
  suppressionsInNewFile,
} from './lint-changed-sonar.js'
import { runScriptCli, useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'

const SCRIPT = 'scripts/lint-changed-sonar.ts'
const NO_ESLINT = '--no-eslint'
const BASE_FLAG = '--base'
const makeFixtureRoot = useFixtureRoots('lint-changed-sonar-', [])

// Built by concatenation so this test file never contains the tokens the scan hunts for.
const SONAR_TOKEN = 'NO' + 'SONAR'
const ESLINT_TOKEN = 'eslint-' + 'disable-next-line'
const TS_TOKEN = '@ts-' + 'expect-error'

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    '/usr/bin/git',
    ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args],
    {
      cwd,
      stdio: 'pipe',
    }
  )
}

describe('parseArgs', () => {
  it('defaults to origin/main with ESLint on', () => {
    expect(parseArgs([])).toEqual({ base: 'origin/main', eslint: true })
  })

  it('accepts --base <ref>, --no-eslint and a pnpm `--` separator', () => {
    expect(parseArgs(['--', BASE_FLAG, 'main', NO_ESLINT])).toEqual({
      base: 'main',
      eslint: false,
    })
  })

  it('rejects --base without a ref and unknown flags', () => {
    expect(() => parseArgs([BASE_FLAG])).toThrow('--base needs a ref')
    expect(() => parseArgs([BASE_FLAG, NO_ESLINT])).toThrow('--base needs a ref')
    expect(() => parseArgs(['--nope'])).toThrow('unknown argument: --nope')
  })
})

describe('classifyFiles', () => {
  it('sends ts/js/svelte files to ESLint and shell files to the shell guard, skipping generated and overlay paths', () => {
    expect(
      classifyFiles([
        'apps/api/src/a.ts',
        'apps/web/src/b.svelte',
        'scripts/run.sh',
        'scripts/x.mjs',
        'README.md',
        'packages/db/src/migrations/0001.ts',
        'packages/x/dist/out.js',
        '_bmad-output/story.md',
        '.claude/worktrees/x/a.ts',
      ])
    ).toEqual({
      lint: ['apps/api/src/a.ts', 'apps/web/src/b.svelte', 'scripts/x.mjs'],
      shell: ['scripts/run.sh'],
    })
  })
})

describe('filesOutsideTsProjects', () => {
  const tsconfigs = new Map([
    ['/r/apps/api/tsconfig.json', '{\n  // comment\n  "include": ["src/**/*.ts"]\n}'],
    ['/r/packages/tsconfig/tsconfig.json', '{ "include": ["**/*.ts"] }'],
    ['/r/apps/web/tsconfig.json', '{ "include": ["src/**/*.ts", ".svelte-kit/ambient.d.ts"] }'],
  ])
  const read = (path: string) => tsconfigs.get(path) ?? null

  it('keeps only the .ts files no tsconfig include covers', () => {
    expect(
      filesOutsideTsProjects(
        '/r',
        [
          'apps/api/src/lib/a.ts',
          'apps/api/vitest.config.ts',
          'apps/web/src/lib/b.ts',
          'apps/web/scripts/poll.test.ts',
          'scripts/check.ts',
          'scripts/lib/x.ts',
          'packages/tsconfig/anything/deep.ts',
          'apps/api/src/readme.md',
        ],
        read
      )
    ).toEqual([
      'apps/api/vitest.config.ts',
      'apps/web/scripts/poll.test.ts',
      'scripts/check.ts',
      'scripts/lib/x.ts',
    ])
  })
})

describe('addedSuppressions', () => {
  it('reports each added line carrying a suppression, with path and new-file line number', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -3,0 +4,3 @@',
      '+const ok = 1',
      `+// ${ESLINT_TOKEN} no-console`,
      `+// ${TS_TOKEN} reason`,
    ].join('\n')
    expect(addedSuppressions(diff)).toEqual([
      `a.ts:5: // ${ESLINT_TOKEN} no-console`,
      `a.ts:6: // ${TS_TOKEN} reason`,
    ])
  })

  it('ignores removed and context lines, the +++ header and the private overlay', () => {
    const diff = [
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,2 +1,1 @@',
      `-// ${SONAR_TOKEN} old`,
      ' const kept = 1',
      '--- a/_bmad-output/s.md',
      '+++ b/_bmad-output/s.md',
      '@@ -1,0 +1,1 @@',
      `+${SONAR_TOKEN} quoted in a story file`,
    ].join('\n')
    expect(addedSuppressions(diff)).toEqual([])
  })

  it('matches every token of the C3 list', () => {
    const tokens = [
      SONAR_TOKEN,
      'eslint-' + 'disable',
      '@ts-' + 'ignore',
      TS_TOKEN,
      'jscpd:' + 'ignore',
      'istanbul ' + 'ignore next',
      'c8 ' + 'ignore next',
    ]
    for (const token of tokens) {
      expect(addedSuppressions(`+++ b/x.ts\n@@ -0,0 +1 @@\n+// ${token}`)).toHaveLength(1)
    }
  })
})

describe('suppressionsInNewFile', () => {
  it('scans the whole content of an untracked file', () => {
    expect(suppressionsInNewFile('n.ts', `a\n// ${TS_TOKEN}\nb\n`)).toEqual([
      `n.ts:2: // ${TS_TOKEN}`,
    ])
    expect(suppressionsInNewFile('n.ts', 'clean\n')).toEqual([])
    expect(suppressionsInNewFile('_bmad-output/s.md', SONAR_TOKEN)).toEqual([])
  })
})

describe('lint-changed-sonar CLI (real git repo, ESLint step skipped)', () => {
  function repoWithBranch(): string {
    const root = makeFixtureRoot()
    git(root, 'init', '-q', '-b', 'main')
    writeFixture(root, 'base.ts', 'export const base = 1\n')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'base')
    git(root, 'checkout', '-q', '-b', 'feature')
    return root
  }

  it('exits 0 when the branch changes only clean files', () => {
    const root = repoWithBranch()
    writeFixture(root, 'tool.sh', 'f() {\n  local a="$1"\n  echo "$a"\n}\n')
    writeFixture(root, 'clean.ts', 'export const clean = 2\n')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'clean')

    const run = runScriptCli(SCRIPT, root, [BASE_FLAG, 'main', NO_ESLINT])
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('clean')
  })

  it('fails on a changed shell file using a positional parameter directly, naming the rule', () => {
    const root = repoWithBranch()
    writeFixture(root, 'tool.sh', 'f() {\n  echo "$1"\n}\n')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'dirty shell')

    const run = runScriptCli(SCRIPT, root, [BASE_FLAG, 'main', NO_ESLINT])
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('shelldre:S7679')
    expect(run.stderr).toContain('tool.sh:2')
  })

  it('fails on an added suppression, committed or untracked, and refuses it', () => {
    const root = repoWithBranch()
    writeFixture(root, 'committed.ts', `// ${TS_TOKEN} nope\nexport const c = 1\n`)
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'suppression')
    writeFixture(root, 'untracked.ts', `// ${ESLINT_TOKEN} no-console\nexport const u = 1\n`)

    const run = runScriptCli(SCRIPT, root, [BASE_FLAG, 'main', NO_ESLINT])
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('committed.ts:1')
    expect(run.stderr).toContain('untracked.ts:1')
  })

  it('does not flag a suppression that already exists on the base', () => {
    const root = makeFixtureRoot()
    git(root, 'init', '-q', '-b', 'main')
    writeFixture(root, 'old.ts', `// ${TS_TOKEN} legacy\nexport const o = 1\n`)
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'legacy')
    git(root, 'checkout', '-q', '-b', 'feature')
    writeFixture(root, 'other.ts', 'export const x = 1\n')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'other')

    const run = runScriptCli(SCRIPT, root, [BASE_FLAG, 'main', NO_ESLINT])
    expect(run.status).toBe(0)
  })

  it('exits 2 when no base ref resolves', () => {
    const root = makeFixtureRoot()
    git(root, 'init', '-q', '-b', 'trunk')
    writeFixture(root, 'a.ts', 'export const a = 1\n')
    git(root, 'add', '.')
    git(root, 'commit', '-q', '-m', 'a')

    const run = runScriptCli(SCRIPT, root, [BASE_FLAG, 'origin/nope', NO_ESLINT])
    expect(run.status).toBe(2)
    expect(run.stderr).toContain('cannot resolve a merge base')
  })
})
