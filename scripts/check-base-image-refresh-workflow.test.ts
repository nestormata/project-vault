import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

// Story 64.4 (Option B): contract for the scheduled base-image refresh workflow and the helper
// script it drives. The workflow rewrites every `FROM node@sha256:` line, opens (or updates) one
// PR, and dispatches ci.yml on the refresh branch because a PR opened with GITHUB_TOKEN does not
// trigger `pull_request` workflows.

// The repository root has no YAML dependency; reuse the `yaml` package apps/api already depends on.
const { parse: parseYaml } = createRequire(resolve(process.cwd(), 'apps/api/package.json'))(
  'yaml'
) as typeof import('yaml')

const ROOT = resolve(__dirname, '..')
const WORKFLOW_PATH = '.github/workflows/base-image-refresh.yml'
const SCRIPT = join(ROOT, 'scripts/refresh-base-image.sh')
const DOCKERFILES = ['apps/api/Dockerfile', 'apps/web/Dockerfile', 'Dockerfile.ci']

type Step = { name?: string; uses?: string; run?: string; env?: Record<string, unknown> }
type Job = { permissions?: Record<string, string>; steps?: Step[] }
type Workflow = {
  on?: Record<string, unknown>
  permissions?: unknown
  jobs?: Record<string, Job>
}

// Loaded at transform time (bracketed names keep the globs literal and non-dynamic) rather than via
// a non-literal readFileSync, which security/detect-non-literal-fs-filename flags.
const REPO_TEXT: Record<string, string> = import.meta.glob(
  [
    '../.github/workflows/base-image-refresh.yml',
    '../.github/workflows/ci.yml',
    '../Makefil[e]',
    '../apps/api/Dockerfil[e]',
    '../apps/web/Dockerfil[e]',
    '../Dockerfile.c[i]',
  ],
  { query: '?raw', import: 'default', eager: true }
)

function read(path: string): string {
  const text = REPO_TEXT[`../${path}`]
  expect(text, `${path} must be loadable`).toBeDefined()
  return text ?? ''
}

/** Reads a file from a throwaway fixture directory (outside the repo, so not globbable). */
function readFixture(dir: string, file: string): string {
  const result = spawnSync('cat', [join(dir, file)], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  return result.stdout
}

const workflowText = read(WORKFLOW_PATH)
const workflow = parseYaml(workflowText) as Workflow
const jobs = Object.values(workflow.jobs ?? {})
const allSteps = jobs.flatMap((job) => job.steps ?? [])
const allRuns = allSteps.map((step) => step.run ?? '').join('\n')

describe('base-image-refresh.yml shape', () => {
  it('runs on a weekly schedule and on workflow_dispatch only', () => {
    expect(Object.keys(workflow.on ?? {}).sort()).toEqual(['schedule', 'workflow_dispatch'])
    const schedule = workflow.on?.schedule as { cron: string }[]
    expect(schedule).toHaveLength(1)
    // Weekly: day-of-week field is a single day, day-of-month and month are wildcards.
    expect(schedule[0].cron).toMatch(/^\d+ \d+ \* \* [0-6]$/)
  })

  it('denies all permissions at the top level and grants the job only what it needs', () => {
    expect(workflow.permissions).toEqual({})
    expect(jobs).toHaveLength(1)
    // actions: write is required for `gh workflow run ci.yml` (the GITHUB_TOKEN PR trap).
    expect(jobs[0].permissions).toEqual({
      contents: 'write',
      'pull-requests': 'write',
      actions: 'write',
    })
  })

  it('uses only first-party actions (no new third-party action)', () => {
    const uses = allSteps.map((step) => step.uses).filter((value): value is string => !!value)
    expect(uses.length).toBeGreaterThan(0)
    for (const ref of uses) expect(ref, ref).toMatch(/^actions\//)
  })

  it('never interpolates github.* expressions into run: scripts (injection safety)', () => {
    expect(allRuns).not.toMatch(/\$\{\{/)
  })

  it('dispatches ci.yml on the refresh branch so the PR is gated', () => {
    expect(allRuns).toMatch(/gh workflow run ci\.yml --ref "?\$\{?BRANCH\}?"?/)
  })

  it('labels the PR base-image, creating the label when missing', () => {
    expect(allRuns).toContain('gh label create base-image')
    expect(allRuns).toMatch(/gh pr create[^\n]*--label base-image/)
  })

  it('is idempotent: reuses an existing refresh PR and no-ops on an unchanged digest', () => {
    expect(allRuns).toMatch(/gh pr list[^\n]*--head/)
    expect(allRuns).toContain('refresh-base-image.sh verify')
    expect(allRuns).toMatch(/changed=false/)
  })

  it('never enables auto-merge on the refresh PR', () => {
    expect(workflowText).not.toMatch(/--auto|auto-merge|automerge|enableAutoMerge/i)
  })
})

describe('ci.yml supports dispatch on the refresh branch', () => {
  const ci = read('.github/workflows/ci.yml')
  const parsed = parseYaml(ci) as Workflow

  it('has a workflow_dispatch trigger', () => {
    expect(parsed.on).toHaveProperty('workflow_dispatch')
  })

  it('treats a dispatch run on a non-default branch as image-input-checked against main', () => {
    const detect = (parsed.jobs?.['docker-build']?.steps ?? []).find(
      (step) => (step as { id?: string }).id === 'image-inputs'
    )
    expect(detect?.run).toContain('workflow_dispatch')
  })
})

describe('refresh-base-image.sh', () => {
  const OLD = 'sha256:' + 'a'.repeat(64)
  const NEW = 'sha256:' + 'b'.repeat(64)
  const scratch: string[] = []

  afterAll(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  })

  function fixture(): string {
    const dir = mkdtempSync(join(tmpdir(), 'refresh-base-image-'))
    scratch.push(dir)
    for (const file of DOCKERFILES) {
      cpSync(join(ROOT, file), join(dir, file), { recursive: true })
    }
    // Make the fixture's pin a known value, independent of the real current digest.
    spawnSync('bash', [SCRIPT, 'rewrite', OLD, dir], { encoding: 'utf8' })
    return dir
  }

  function run(...args: string[]) {
    return spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8' })
  }

  it('rewrites all six FROM lines across the three Dockerfiles and leaves the rest intact', () => {
    const dir = fixture()
    const before = DOCKERFILES.map((file) => readFixture(dir, file))
    const result = run('rewrite', NEW, dir)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('rewrote 6 FROM lines')

    const after = DOCKERFILES.map((file) => readFixture(dir, file))
    for (const text of after) {
      expect(text).not.toContain(OLD)
      expect(text).toContain(NEW)
    }
    expect(after.join('').split(NEW)).toHaveLength(7)
    expect(after.join('').replaceAll(NEW, OLD)).toBe(before.join(''))
    expect(run('current', dir).stdout.trim()).toBe(NEW)
  })

  it('keeps the bare-digest form (never adds a tag)', () => {
    const dir = fixture()
    run('rewrite', NEW, dir)
    for (const file of DOCKERFILES) {
      expect(readFixture(dir, file)).toMatch(/^FROM node@sha256:/m)
      expect(readFixture(dir, file)).not.toMatch(/^FROM node:/m)
    }
  })

  it('rejects a malformed digest without touching any file', () => {
    const dir = fixture()
    const result = run('rewrite', 'sha256:xyz', dir)
    expect(result.status).not.toBe(0)
    expect(run('current', dir).stdout.trim()).toBe(OLD)
  })

  it('reports an error when the FROM lines disagree', () => {
    const dir = fixture()
    const file = join(dir, 'Dockerfile.ci')
    spawnSync('sed', ['-i', `s/${OLD}/${NEW}/`, file])
    const result = run('current', dir)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('more than one digest')
  })

  it('the real repository pins agree with the script (current exits 0)', () => {
    const result = run('current', ROOT)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})

describe('guard wiring (G3)', () => {
  it('ci.yml runs the contract test', () => {
    expect(read('.github/workflows/ci.yml')).toContain(
      'pnpm vitest run scripts/check-base-image-refresh-workflow.test.ts'
    )
  })

  it("Makefile's ci-inner runs the contract test", () => {
    const ciInner = /\nci-inner:[\s\S]*?(?=\n\S)/.exec(read('Makefile'))?.[0] ?? ''
    expect(ciInner).toContain('scripts/check-base-image-refresh-workflow.test.ts')
  })
})
