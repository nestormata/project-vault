import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveTrustedExecutable } from './lib/trusted-executable.js'

// Story 66-20 guard: the PR-time e2e smoke gate (scripts/pr-e2e-smoke-gate.sh) and the two ci.yml
// jobs that use it. The gate decides run=true|false from the PR's changed files and FAILS OPEN on
// any lookup problem. The workflow assertions fail if someone "fixes" a red or slow job by
// loosening it (continue-on-error, secrets, a direct compose up, a list of journeys that can drift
// from the suite) instead of the cause. The job runs the FULL suite (decision recorded in
// specs/project-vault-e2e-stack-and-nightly.md), so there is no subset list to keep in sync.

const SCRIPT = resolve(import.meta.dirname, 'pr-e2e-smoke-gate.sh')
const BASH = resolveTrustedExecutable('bash')
const GIT = resolveTrustedExecutable('git')
const ZERO_SHA = '0'.repeat(40)
const WARNING = '::warning::'

const ci = Object.values(
  import.meta.glob('../.github/workflows/ci.yml', { query: '?raw', import: 'default', eager: true })
).join('\n') as string
const gateScript = Object.values(
  import.meta.glob('./pr-e2e-smoke-gate.sh', { query: '?raw', import: 'default', eager: true })
).join('\n') as string
// Only the key names are used (no module is loaded): every first-level subtree of the web app.
const webSubtrees = [
  ...new Set(
    Object.keys(import.meta.glob('../apps/web/{src,messages}/*/**', { query: '?url' })).map((key) =>
      key.split('/').slice(1, 5).join('/')
    )
  ),
].filter((entry) => !entry.includes('.'))

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type Change = { path: string; content?: string }

function git(cwd: string, args: string[], input?: string): string {
  const result = spawnSync(
    GIT,
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', input }
  )
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

// Builds a commit holding exactly `files` using plumbing only (blob, index, tree, commit), so the
// test writes nothing to disk besides the temp repository itself.
function commitTree(root: string, files: Map<string, string>, parent?: string): string {
  git(root, ['read-tree', '--empty'])
  for (const [path, content] of files) {
    const blob = git(root, ['hash-object', '-w', '--stdin'], content)
    git(root, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`])
  }
  const tree = git(root, ['write-tree'])
  const parents = parent ? ['-p', parent] : []
  return git(root, ['commit-tree', tree, ...parents, '-m', 'c'])
}

function applyChanges(
  baseFiles: Map<string, string>,
  changes: Change[],
  renames: Array<[string, string]>
): Map<string, string> {
  const headFiles = new Map(baseFiles)
  for (const [from, to] of renames) {
    headFiles.set(to, headFiles.get(from) ?? '')
    headFiles.delete(from)
  }
  for (const c of changes) headFiles.set(c.path, c.content ?? `changed ${c.path}\n`)
  return headFiles
}

function baseShaValue(kind: 'real' | 'zero' | 'missing' | 'unknown', real: string): string {
  if (kind === 'zero') return ZERO_SHA
  if (kind === 'missing') return ''
  if (kind === 'unknown') return 'f'.repeat(40)
  return real
}

type Scenario = {
  eventName?: string
  base?: Change[]
  changes?: Change[]
  renames?: Array<[string, string]>
  baseSha?: 'real' | 'zero' | 'missing' | 'unknown'
}

function run({
  eventName = 'pull_request',
  base = [{ path: 'README.md', content: 'base\n' }],
  changes = [],
  renames = [],
  baseSha = 'real',
}: Scenario) {
  const root = mkdtempSync(join(tmpdir(), 'pr-e2e-smoke-gate-'))
  roots.push(root)
  git(root, ['init', '-q', '-b', 'main'])
  const baseFiles = new Map(base.map((c) => [c.path, c.content ?? `base ${c.path}\n`]))
  const baseCommit = commitTree(root, baseFiles)
  const headCommit = commitTree(root, applyChanges(baseFiles, changes, renames), baseCommit)
  // GITHUB_OUTPUT/GITHUB_STEP_SUMMARY unset: the script writes both to stdout, split below.
  const result = spawnSync(BASH, [SCRIPT], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: process.env['PATH'] ?? '',
      EVENT_NAME: eventName,
      BASE_SHA: baseShaValue(baseSha, baseCommit),
      HEAD_SHA: headCommit,
    },
  })
  const lines = result.stdout.split('\n').filter(Boolean)
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: lines.filter((l) => l.startsWith('run=')).join('\n'),
    summary: lines.filter((l) => !l.startsWith('run=') && !l.startsWith('::')).join('\n'),
  }
}

// Every path DW-406 / the story AC-3 names, plus the sub-trees Elicitation 2 pins.
const GATED_PATHS = [
  'apps/web/messages/en.json',
  'apps/web/messages/es/nested/file.json',
  'apps/web/src/routes/(app)/projects/+page.svelte',
  'apps/web/src/lib/components/Button.svelte',
  'apps/web/src/lib/stores/anything.ts',
  'apps/web/e2e/journeys/j1-onboarding-and-first-credential.spec.ts',
  'apps/web/playwright.config.ts',
  'packages/extension-api/src/manifest.ts',
  'packages/extension-api/src/index.ts',
  'apps/api/src/extensions/status-routes.ts',
  'apps/api/src/auth/service.ts',
  'fixtures/extensions/envelope/manifest.json',
  'docker-compose.yml',
  'docker-compose.e2e.yml',
  'scripts/e2e-stack.sh',
  'scripts/pr-e2e-smoke-gate.sh',
  '.github/workflows/ci.yml',
]
const UNGATED_PATHS = [
  'README.md',
  'docs/development.md',
  'specs/anything.md',
  'apps/api/README.md',
  '.github/workflows/nightly.yml',
  'scripts/check-nightly-workflow.test.ts',
]

describe('gate script: path matching', () => {
  it.each(GATED_PATHS)('a PR touching %s runs the smoke job', (path) => {
    const result = run({ changes: [{ path }] })
    expect(result.status).toBe(0)
    expect(result.output).toBe('run=true')
    expect(result.summary).toMatch(/^Running:/)
    expect(result.summary).toContain(path)
  })

  it.each(UNGATED_PATHS)('a PR touching only %s skips with a reason', (path) => {
    const result = run({ changes: [{ path }] })
    expect(result.status).toBe(0)
    expect(result.output).toBe('run=false')
    expect(result.summary).toMatch(/^Skipped: no e2e-relevant path changed/)
  })

  it('a docs-only PR with several files is skipped, one gated file among them runs', () => {
    const docs = [{ path: 'docs/a.md' }, { path: 'specs/b.md' }]
    expect(run({ changes: docs }).output).toBe('run=false')
    expect(run({ changes: [...docs, { path: 'apps/web/messages/en.json' }] }).output).toBe(
      'run=true'
    )
  })

  it('counts a rename on both the old and the new path', () => {
    const base = [{ path: 'apps/web/src/routes/old/+page.svelte' }, { path: 'README.md' }]
    // moved OUT of a gated tree: the old path is still gated
    const out = run({
      base,
      renames: [['apps/web/src/routes/old/+page.svelte', 'docs/moved.svelte']],
    })
    expect(out.output).toBe('run=true')
    // moved INTO a gated tree: the new path is gated
    const intoBase = [{ path: 'docs/page.svelte' }]
    const into = run({
      base: intoBase,
      renames: [['docs/page.svelte', 'apps/web/src/routes/new/+page.svelte']],
    })
    expect(into.output).toBe('run=true')
  })

  it('gates every first-level web subtree, so a new directory cannot dodge the list', () => {
    expect(webSubtrees.length).toBeGreaterThan(0)
    for (const subtree of webSubtrees) {
      expect(run({ changes: [{ path: `${subtree}/new-file.ts` }] }).output, subtree).toBe(
        'run=true'
      )
    }
  })
})

describe('gate script: events and failure modes', () => {
  it.each(['push', 'workflow_dispatch', 'merge_group'])(
    '%s always runs, even for a docs-only change',
    (eventName) => {
      const result = run({ eventName, changes: [{ path: 'docs/a.md' }] })
      expect(result.status).toBe(0)
      expect(result.output).toBe('run=true')
      expect(result.summary).toContain(eventName)
    }
  )

  it('an empty diff is skipped', () => {
    const result = run({ changes: [] })
    expect(result.output).toBe('run=false')
    expect(result.summary).toMatch(/^Skipped: no changed files/)
  })

  it.each(['zero', 'missing', 'unknown'] as const)(
    'a %s base SHA fails open: run=true plus a ::warning::',
    (baseSha) => {
      const result = run({ baseSha, changes: [{ path: 'docs/a.md' }] })
      expect(result.status).toBe(0)
      expect(result.output).toBe('run=true')
      expect(result.stdout).toContain(WARNING)
      expect(result.summary).toMatch(/failing open/)
    }
  )

  it('an unknown event name fails open too', () => {
    const result = run({ eventName: 'something_new', changes: [{ path: 'docs/a.md' }] })
    expect(result.output).toBe('run=true')
    expect(result.summary).toMatch(/failing open/)
  })

  it('keeps the warning on one line (a workflow command annotation must)', () => {
    const result = run({ baseSha: 'unknown', changes: [{ path: 'docs/a.md' }] })
    const warning = result.stdout.split('\n').filter((line) => line.startsWith(WARNING))
    expect(warning).toHaveLength(1)
  })
})

describe('gate script source', () => {
  it('is strict, fail-open and keeps the path list in one place', () => {
    expect(gateScript).toContain('set -euo pipefail')
    expect(gateScript).toContain(WARNING)
    expect(gateScript).toMatch(/failing open/)
    expect(gateScript).toContain('--name-status')
    expect(gateScript.match(/GATED_PREFIXES=\(/g)).toHaveLength(1)
  })
})

// Splits the `jobs:` block into jobId -> rawJobText on two-space-indented job keys.
function parseJobs(text: string): Map<string, string> {
  const body = text.slice(text.indexOf('\njobs:\n') + '\njobs:\n'.length)
  const jobs = new Map<string, string>()
  let current: string | undefined
  for (const line of body.split('\n')) {
    const header = /^ {2}([a-z][\w-]*):\s*$/.exec(line)
    if (header) {
      current = header[1]
      jobs.set(current, '')
    } else if (current) {
      jobs.set(current, `${jobs.get(current) ?? ''}${line}\n`)
    }
  }
  return jobs
}

const jobs = parseJobs(ci)
const gateJob = jobs.get('e2e-smoke-gate') ?? ''
const smokeJob = jobs.get('e2e-smoke') ?? ''
const stripComments = (text: string): string =>
  text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')

describe('ci.yml e2e-smoke-gate job', () => {
  it('exists, checks out full history, and runs the gate script with the PR base', () => {
    expect(gateJob).not.toBe('')
    expect(gateJob).toMatch(/fetch-depth:\s*0/)
    expect(gateJob).toMatch(/outputs:\s*\n\s+run: \$\{\{ steps\.gate\.outputs\.run \}\}/)
    expect(gateJob).toMatch(/- name: [^\n]*\n\s+id: gate\b/)
    expect(gateJob).toContain('./scripts/pr-e2e-smoke-gate.sh')
    expect(gateJob).toContain('EVENT_NAME: ${{ github.event_name }}')
    expect(gateJob).toContain('BASE_SHA: ${{ github.event.pull_request.base.sha }}')
    expect(gateJob).toContain('HEAD_SHA: ${{ github.sha }}')
    expect(gateJob).toMatch(/timeout-minutes:\s*\d+/)
  })
})

describe('ci.yml e2e-smoke job', () => {
  const body = stripComments(smokeJob)

  it('is named "PR e2e smoke", needs the gate, and is skipped when the gate says no', () => {
    expect(smokeJob).not.toBe('')
    expect(smokeJob).toMatch(/^ {4}name: PR e2e smoke\s*$/m)
    expect(smokeJob).toMatch(/^ {4}needs:\s*e2e-smoke-gate\s*$/m)
    expect(smokeJob).toContain("if: needs.e2e-smoke-gate.outputs.run == 'true'")
  })

  it('reuses the nightly stack boot via e2e-stack.sh and never runs compose up directly', () => {
    expect(body).toContain('./scripts/e2e-stack.sh up')
    expect(body).toContain('./scripts/e2e-stack.sh wait')
    expect(body.indexOf('e2e-stack.sh up')).toBeLessThan(body.indexOf('e2e-stack.sh wait'))
    expect(body).not.toMatch(/docker[ -]compose[^\n]*\bup\b/)
    expect(body).toContain('playwright install --with-deps chromium')
  })

  it('runs the full suite with the DB-reset opt-in, no spec list to drift', () => {
    expect(body).toContain(
      'run: E2E_CONFIRM_DB_RESET=true pnpm --filter @project-vault/web-host test:e2e\n'
    )
  })

  it('uploads traces on failure and on cancel, named per run attempt', () => {
    expect(body).toContain('if: failure() || cancelled()')
    expect(body).toContain('apps/web/e2e/test-results/')
    expect(body).toContain('playwright-smoke-report-${{ github.run_id }}-${{ github.run_attempt }}')
  })

  it('has no secrets, no continue-on-error, no pull_request_target, a measured timeout', () => {
    expect(smokeJob).not.toContain('secrets.')
    expect(body).not.toContain('continue-on-error')
    expect(stripComments(ci)).not.toContain('pull_request_target')
    const minutes = Number(/^ {4}timeout-minutes:\s*(\d+)/m.exec(smokeJob)?.[1])
    // 3x the 9-minute green nightly (run 37059015596), rounded: 30. Never blind-raised.
    expect(minutes).toBeGreaterThanOrEqual(27)
    expect(minutes).toBeLessThanOrEqual(30)
  })
})

describe('ci.yml keeps the smoke job advisory and the guard wired', () => {
  it('does not add the smoke job to any job that depends on it (nothing waits on it)', () => {
    for (const [id, text] of jobs) {
      if (id === 'e2e-smoke') continue
      expect(text, id).not.toMatch(/needs:[^\n]*\be2e-smoke\b(?!-gate)/)
    }
  })

  it('runs this guard in the Checks job', () => {
    expect(ci).toContain('pnpm vitest run scripts/pr-e2e-smoke-gate.test.ts')
  })

  it('does not filter the whole workflow by path (that would skip required checks)', () => {
    const triggers = ci.slice(0, ci.indexOf('\njobs:'))
    expect(triggers).not.toMatch(/^\s+paths(-ignore)?:/m)
  })
})
