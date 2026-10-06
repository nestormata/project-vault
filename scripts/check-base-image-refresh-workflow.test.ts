import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
const POSTGRES_DOCKERFILE = 'deploy/fly/db/Dockerfile'
const ALL_DOCKERFILES = [...DOCKERFILES, POSTGRES_DOCKERFILE]

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
  return readFileSync(join(dir, file), 'utf8')
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

  it('refreshes every image family the script lists, per image (Story 64.6 AC-7)', () => {
    expect(allRuns).toContain('refresh-base-image.sh images')
    expect(allRuns).toMatch(/refresh-base-image\.sh (current|resolve|verify|rewrite)[^\n]*--image/)
  })

  it('stages and guards every refreshable Dockerfile, including the Fly db image', () => {
    for (const file of ALL_DOCKERFILES) {
      expect(allRuns, file).toContain(file)
    }
    expect(allRuns).toMatch(/git add [^\n]*deploy\/fly\/db\/Dockerfile/)
  })

  it('does not hard-code a stale FROM-line count or node-only wording in the PR text', () => {
    expect(allRuns).not.toMatch(/All six/)
    expect(allRuns).not.toContain('refresh node base image digest')
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
  const OLD_PG = 'sha256:' + 'c'.repeat(64)
  const NEW_PG = 'sha256:' + 'd'.repeat(64)
  const scratch: string[] = []

  afterAll(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  })

  function fixture(): string {
    const dir = mkdtempSync(join(tmpdir(), 'refresh-base-image-'))
    scratch.push(dir)
    for (const file of ALL_DOCKERFILES) {
      cpSync(join(ROOT, file), join(dir, file), { recursive: true })
    }
    // Make the fixture's pins known values, independent of the real current digests.
    spawnSync('bash', [SCRIPT, 'rewrite', OLD, dir], { encoding: 'utf8' })
    spawnSync('bash', [SCRIPT, 'rewrite', '--image', 'postgres', OLD_PG, dir], {
      encoding: 'utf8',
    })
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
    const postgres = run('current', '--image', 'postgres', ROOT)
    expect(postgres.status, postgres.stderr).toBe(0)
    expect(postgres.stdout.trim()).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('lists the image families it can refresh (guard contract, Story 64.6 AC-13)', () => {
    const result = run('images')
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.split('\n').filter(Boolean)).toEqual(['node', 'postgres'])
  })

  it('T10: rewriting postgres changes only deploy/fly/db/Dockerfile', () => {
    const dir = fixture()
    const before = ALL_DOCKERFILES.map((file) => readFixture(dir, file))
    const result = run('rewrite', '--image', 'postgres', NEW_PG, dir)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('rewrote 1 FROM lines')

    const after = ALL_DOCKERFILES.map((file) => readFixture(dir, file))
    expect(after.slice(0, 3)).toEqual(before.slice(0, 3))
    expect(after[3]).toContain(`FROM postgres@${NEW_PG} AS runner`)
    expect(after[3]).not.toContain(OLD_PG)
    expect(after[3].replace(NEW_PG, OLD_PG)).toBe(before[3])
    expect(run('current', '--image', 'postgres', dir).stdout.trim()).toBe(NEW_PG)
    expect(run('current', dir).stdout.trim()).toBe(OLD)
  })

  it('rewriting node leaves the postgres pin alone', () => {
    const dir = fixture()
    const before = readFixture(dir, POSTGRES_DOCKERFILE)
    expect(run('rewrite', NEW, dir).status).toBe(0)
    expect(readFixture(dir, POSTGRES_DOCKERFILE)).toBe(before)
  })

  it('rewrites FROM lines the guard accepts: --platform option and lowercase from', () => {
    const dir = fixture()
    const file = join(dir, POSTGRES_DOCKERFILE)
    spawnSync('sed', ['-i', 's#^FROM postgres@#from --platform=linux/amd64 postgres@#', file])
    expect(run('current', '--image', 'postgres', dir).stdout.trim()).toBe(OLD_PG)
    expect(run('rewrite', '--image', 'postgres', NEW_PG, dir).status).toBe(0)
    expect(readFixture(dir, POSTGRES_DOCKERFILE)).toContain(
      `from --platform=linux/amd64 postgres@${NEW_PG}`
    )
  })

  it('keeps the postgres pin a bare digest and is a no-op when the digest is unchanged', () => {
    const dir = fixture()
    const before = readFixture(dir, POSTGRES_DOCKERFILE)
    expect(run('rewrite', '--image', 'postgres', OLD_PG, dir).status).toBe(0)
    expect(readFixture(dir, POSTGRES_DOCKERFILE)).toBe(before)
    expect(before).toMatch(/^FROM postgres@sha256:/m)
    expect(before).not.toMatch(/^FROM postgres:/m)
  })

  it('rejects an unknown image, naming it', () => {
    const result = run('current', '--image', 'alpine', ROOT)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('alpine')
  })

  it('T11: verify refuses a registry rollback (older libssl3), naming the image', () => {
    // The version comparison is the rollback gate; the registry fetch is exercised live.
    const floor = '3.5.8-r0'
    const versionGe = (candidate: string) => run('version-ge', candidate, floor).status
    expect(versionGe(floor)).toBe(0)
    expect(versionGe('3.5.10-r0')).toBe(0)
    expect(versionGe('3.5.7-r1')).not.toBe(0)
    const malformed = run('verify', '--image', 'postgres', 'sha256:xyz', NEW_PG)
    expect(malformed.status).not.toBe(0)
    expect(malformed.stderr).toContain('not a sha256 digest')
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
