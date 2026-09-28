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
const ciComposePath = resolve(repositoryRoot, 'docker-compose.ci.yml')
const ciOverlayComposePath = resolve(repositoryRoot, 'docker-compose.ci-overlay.yml')
const CONDITIONAL_OVERLAY_INCLUDE = '$(if $(PRIVATE_OVERLAY_ROOT),-f docker-compose.ci-overlay.yml)'

// Story 43.11 AC-6.4: the story-integrity guards' own test files, run with `--dir scripts` so
// vitest's positional substring filters cannot also match stale copies in nested agent worktrees.
const STORY_INTEGRITY_TEST_COMMAND =
  'pnpm vitest run --dir scripts check-sprint-status-rollup.test.ts check-story-status-sync.test.ts ' +
  'check-deferred-work-ids.test.ts next-dw-id.test.ts lib/deferred-work-ledger.test.ts ' +
  'check-ci-story-integrity-wiring.test.ts'

const GUARDS = {
  'check-story-status-sync': 'tsx scripts/check-story-status-sync.ts',
  'check-sprint-status-rollup': 'tsx scripts/check-sprint-status-rollup.ts',
  'check-deferred-work-ids': 'tsx scripts/check-deferred-work-ids.ts',
  'check-story-references': 'tsx scripts/check-story-references.ts',
  'check-psc-tbd-tracking': 'tsx scripts/check-psc-tbd-tracking.ts',
  'check-story-review-deferrals': 'tsx scripts/check-story-review-deferrals.ts',
  'check-alert-pending-epic3': 'tsx scripts/check-alert-pending-epic3.ts',
  'check-followup-review-gate': 'tsx scripts/check-followup-review-gate.ts',
  'check-epic-retro-freshness': 'tsx scripts/check-epic-retro-freshness.ts',
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

/** The `ci:` target's recipe (up to the next target). */
function ciRecipe(makefile: string): string {
  const start = makefile.search(/^ci:/m)
  if (start < 0) throw new Error('Makefile has no ci target')
  const afterStart = makefile.slice(start)
  const nextTarget = afterStart.slice(1).search(/\n[a-zA-Z0-9_-]+:.*\n/)
  return nextTarget < 0 ? afterStart : afterStart.slice(0, nextTarget + 2)
}

function assertOverlayMountWiring(
  makefile: string,
  overlayCompose: string,
  baseCompose: string
): void {
  // (i) read-only same-path mount of the private overlay root
  expect(overlayCompose).toMatch(
    /^\s*- \$\{PRIVATE_OVERLAY_ROOT:\?[^}]*\}:\$\{PRIVATE_OVERLAY_ROOT\}:ro\s*$/m
  )
  // (ii) the ci recipe includes the override only inside $(if $(PRIVATE_OVERLAY_ROOT),...)
  const recipe = ciRecipe(makefile)
  expect(recipe).toContain(CONDITIONAL_OVERLAY_INCLUDE)
  expect(recipe.replace(CONDITIONAL_OVERLAY_INCLUDE, '')).not.toContain(
    'docker-compose.ci-overlay.yml'
  )
  // quoted, so an overlay path containing spaces stays one shell word (code review)
  expect(recipe).toContain("PRIVATE_OVERLAY_ROOT='$(PRIVATE_OVERLAY_ROOT)' \\")
  expect(makefile).toMatch(/^PRIVATE_OVERLAY_ROOT := \$\(shell .*readlink -f .*\)$/m)
  // (iii) the base compose file never depends on PRIVATE_OVERLAY_ROOT
  expect(baseCompose).not.toContain('PRIVATE_OVERLAY_ROOT')
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

  it('runs the story-integrity guard test files in ci-inner and ci.yml, scoped with --dir scripts (Story 43.11 AC-6.4)', () => {
    const recipeLines = ciInnerRecipe(readFileSync(makefilePath, 'utf8')).split('\n')
    expect(recipeLines.filter((line) => line === `\t${STORY_INTEGRITY_TEST_COMMAND}`)).toHaveLength(
      1
    )
    const workflowLines = readFileSync(postMergeWorkflowPath, 'utf8').split('\n')
    expect(
      workflowLines.filter((line) => line.trim() === `run: ${STORY_INTEGRITY_TEST_COMMAND}`)
    ).toHaveLength(1)
  })

  it('make ci mounts the private overlay read-only, only when it resolves (Story 43.11 AC-11)', () => {
    assertOverlayMountWiring(
      readFileSync(makefilePath, 'utf8'),
      readFileSync(ciOverlayComposePath, 'utf8'),
      readFileSync(ciComposePath, 'utf8')
    )
  })

  it('rejects a writable overlay mount, an unconditional include, and a base-compose reference (Story 43.11 AC-11)', () => {
    const makefile = readFileSync(makefilePath, 'utf8')
    const overlay = readFileSync(ciOverlayComposePath, 'utf8')
    const base = readFileSync(ciComposePath, 'utf8')

    expect(() =>
      assertOverlayMountWiring(makefile, overlay.replace('}:ro', '}:rw'), base)
    ).toThrow()
    expect(() => assertOverlayMountWiring(makefile, overlay.replace('}:ro', '}'), base)).toThrow()
    expect(() =>
      assertOverlayMountWiring(
        makefile.replace(CONDITIONAL_OVERLAY_INCLUDE, '-f docker-compose.ci-overlay.yml'),
        overlay,
        base
      )
    ).toThrow()
    expect(() =>
      assertOverlayMountWiring(makefile, overlay, `${base}\n# \${PRIVATE_OVERLAY_ROOT}\n`)
    ).toThrow()
    expect(() =>
      assertOverlayMountWiring(
        makefile.replace(
          "PRIVATE_OVERLAY_ROOT='$(PRIVATE_OVERLAY_ROOT)'",
          'PRIVATE_OVERLAY_ROOT=$(PRIVATE_OVERLAY_ROOT)'
        ),
        overlay,
        base
      )
    ).toThrow()
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
