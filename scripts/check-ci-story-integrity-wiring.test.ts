import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJsonPath = resolve(repositoryRoot, 'package.json')
const makefilePath = resolve(repositoryRoot, 'Makefile')
const postMergeWorkflowPath = resolve(repositoryRoot, '.github/workflows/ci.yml')
const POST_MERGE_JOB_NAME = 'post-merge-status-drift'

const GUARDS = {
  'check-story-status-sync': 'tsx scripts/check-story-status-sync.ts',
  'check-sprint-status-rollup': 'tsx scripts/check-sprint-status-rollup.ts',
  'check-story-references': 'tsx scripts/check-story-references.ts',
  'check-psc-tbd-tracking': 'tsx scripts/check-psc-tbd-tracking.ts',
  'check-story-review-deferrals': 'tsx scripts/check-story-review-deferrals.ts',
  'check-alert-pending-epic3': 'tsx scripts/check-alert-pending-epic3.ts',
  'check-post-merge-status-drift': 'tsx scripts/check-post-merge-status-drift.ts',
} as const

const PRE_MERGE_GUARDS = Object.keys(GUARDS).filter(
  (name) => name !== 'check-post-merge-status-drift'
)

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function packageScripts(raw: string): Record<string, string> {
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || !('scripts' in parsed)) {
    throw new Error('package.json does not contain a scripts object')
  }
  const scripts = parsed.scripts
  if (!scripts || typeof scripts !== 'object') {
    throw new Error('package.json scripts is not an object')
  }
  return scripts as Record<string, string>
}

function countJsonProperty(raw: string, property: string): number {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return [...raw.matchAll(new RegExp(`"${escaped}"\\s*:`, 'g'))].length
}

function ciInnerRecipe(makefile: string): string {
  const start = makefile.indexOf('ci-inner:')
  if (start < 0) throw new Error('Makefile has no ci-inner target')
  const afterStart = makefile.slice(start)
  const nextTarget = afterStart.search(/\n[a-zA-Z0-9_-]+:.*\n/)
  return nextTarget < 0 ? afterStart : afterStart.slice(0, nextTarget + 1)
}

function workflowJob(workflow: string, jobName: string): string {
  const marker = `\n  ${jobName}:\n`
  const start = workflow.indexOf(marker)
  if (start < 0) throw new Error(`workflow has no ${jobName} job`)
  const afterStart = workflow.slice(start + marker.length)
  const nextJob = afterStart.search(/\n  [a-zA-Z0-9_-]+:\s*(?:#.*)?\n/)
  return nextJob < 0 ? afterStart : afterStart.slice(0, nextJob + 1)
}

function replaceWorkflowJob(
  workflow: string,
  jobName: string,
  transform: (job: string) => string
): string {
  const marker = `\n  ${jobName}:\n`
  const start = workflow.indexOf(marker)
  if (start < 0) throw new Error(`workflow has no ${jobName} job`)
  const job = workflowJob(workflow, jobName)
  return `${workflow.slice(0, start)}${marker}${transform(job)}${workflow.slice(
    start + marker.length + job.length
  )}`
}

function assertCiInnerWiring(makefile: string): void {
  const recipe = ciInnerRecipe(makefile)
  for (const guard of PRE_MERGE_GUARDS) {
    const command = `pnpm ${guard}`
    expect(recipe.match(new RegExp(`^\\s*${escapeRegExp(command)}$`, 'gm'))).toHaveLength(1)
    expect(recipe).not.toMatch(new RegExp(`${command}.*(\\|\\||continue-on-error|[>]{1,2})`))
  }

  const broadSuite = recipe.indexOf('\n\t$(MAKE) test')
  expect(broadSuite).toBeGreaterThan(-1)
  for (const guard of PRE_MERGE_GUARDS) {
    expect(recipe.indexOf(`pnpm ${guard}`)).toBeLessThan(broadSuite)
  }
}

function assertPostMergeWiring(workflow: string): void {
  const job = workflowJob(workflow, POST_MERGE_JOB_NAME)
  expect(job).toContain("if: github.event_name == 'push' && github.ref == 'refs/heads/main'")
  expect(job).toContain('fetch-depth: 0')
  expect(job.match(/^[ \t]*run:[ \t]*pnpm check-post-merge-status-drift[ \t]*$/gm)).toHaveLength(1)
}

describe('story-integrity CI wiring', () => {
  it('restores exactly one root package command for every guard and points at a tracked source path', () => {
    const raw = readFileSync(packageJsonPath, 'utf8')
    const scripts = packageScripts(raw)

    for (const [name, command] of Object.entries(GUARDS)) {
      expect(scripts[name], name).toBe(command)
      expect(countJsonProperty(raw, name), `${name} duplicate package entry`).toBe(1)
      const scriptPath = command.replace('tsx ', '')
      expect(existsSync(resolve(repositoryRoot, scriptPath)), `${name} source path`).toBe(true)
      expect(command).not.toMatch(/\/home\/|\.agents|\.claude|project-vault-private/)
    }
  })

  it('rejects missing, duplicated, and wrong-path mappings for every guard', () => {
    const raw = readFileSync(packageJsonPath, 'utf8')
    for (const [name, command] of Object.entries(GUARDS)) {
      const mappingLine = `    "${name}": "${command}",`
      expect(raw).toContain(mappingLine)

      const missing = raw.replace(mappingLine, '')
      const missingScripts = packageScripts(missing)
      expect(missingScripts[name], `${name} missing`).not.toBe(command)

      const duplicate = raw.replace(mappingLine, `${mappingLine}\n${mappingLine}`)
      expect(countJsonProperty(duplicate, name), `${name} duplicate`).toBe(2)

      const wrongPath = raw.replace(
        `"${name}": "${command}"`,
        `"${name}": "${command.replace(/\.ts$/, '-renamed.ts')}"`
      )
      const wrongScripts = packageScripts(wrongPath)
      expect(wrongScripts[name], `${name} wrong path`).not.toBe(command)
    }

    expect(() => packageScripts('{')).toThrow()
  })

  it('runs each pre-merge guard exactly once in ci-inner before the broad suite', () => {
    assertCiInnerWiring(readFileSync(makefilePath, 'utf8'))
  })

  it('rejects duplicate and swallowed ci-inner guard commands', () => {
    const makefile = readFileSync(makefilePath, 'utf8')
    for (const guard of PRE_MERGE_GUARDS) {
      const commandLine = `\tpnpm ${guard}\n`
      const duplicate = makefile.replace(commandLine, `${commandLine}\tpnpm ${guard}\n`)
      expect(() => assertCiInnerWiring(duplicate), `${guard} duplicate`).toThrow()

      const swallowed = makefile.replace(commandLine, `\tpnpm ${guard} || true\n`)
      expect(() => assertCiInnerWiring(swallowed), `${guard} swallowed`).toThrow()
    }
  })

  it('keeps post-merge execution in the public push-to-main full-history job exactly once', () => {
    const workflow = readFileSync(postMergeWorkflowPath, 'utf8')
    assertPostMergeWiring(workflow)
    const executableLines = workflowJob(workflow, POST_MERGE_JOB_NAME)
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
    expect(executableLines).not.toMatch(/\.agents|\.claude|project-vault-private/)
  })

  it('rejects a dormant post-merge command when full history or exact invocation is removed', () => {
    const workflow = readFileSync(postMergeWorkflowPath, 'utf8')
    const shallow = replaceWorkflowJob(workflow, POST_MERGE_JOB_NAME, (job) =>
      job.replace('fetch-depth: 0', 'fetch-depth: 1')
    )
    expect(() => assertPostMergeWiring(shallow)).toThrow()

    const duplicate = workflow.replace(
      'run: pnpm check-post-merge-status-drift',
      'run: pnpm check-post-merge-status-drift\n        run: pnpm check-post-merge-status-drift'
    )
    expect(() => assertPostMergeWiring(duplicate)).toThrow()
  })

  it('fails non-zero on a representative status-sync fixture instead of turning a finding green', () => {
    const script = resolve(repositoryRoot, 'scripts/check-story-status-sync.ts')
    const tsxLoader = resolve(repositoryRoot, 'node_modules/tsx/dist/esm/index.mjs')
    const fixture = mkdtempSync(resolve(tmpdir(), 'ci-story-integrity-wiring-'))

    try {
      const artifacts = resolve(fixture, '_bmad-output/implementation-artifacts')
      mkdirSync(artifacts, { recursive: true })
      writeFileSync(
        resolve(artifacts, 'sprint-status.yaml'),
        'development_status:\n  1-1-fixture: done\n'
      )
      writeFileSync(resolve(artifacts, '1-1-fixture.md'), '# Fixture\n\nStatus: review\n')

      expect(() =>
        execFileSync(process.execPath, ['--import', tsxLoader, realpathSync(script)], {
          cwd: fixture,
          stdio: 'pipe',
        })
      ).toThrow()
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
