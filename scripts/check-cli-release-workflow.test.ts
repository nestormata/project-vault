import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The repository root has no YAML dependency; reuse the `yaml` package apps/api already depends on.
const { parse: parseYaml } = createRequire(resolve(process.cwd(), 'apps/api/package.json'))(
  'yaml'
) as typeof import('yaml')

/** Story 43.6 AC-5 — the `pvault` release workflow's contract. */
const workflowPath = resolve(process.cwd(), '.github/workflows/cli-release.yml')

function workflowText(): string {
  return readFileSync(workflowPath, 'utf8')
}

type Workflow = {
  on?: Record<string, { types?: unknown; inputs?: Record<string, unknown> } | null>
  concurrency?: { group?: unknown; 'cancel-in-progress'?: unknown }
}

function parseWorkflow(text: string): Workflow {
  return parseYaml(text) as Workflow
}

/** Runs only for published releases or a manual dispatch that names the tag — nothing else. */
function triggerViolations(workflow: Workflow): string[] {
  const on = workflow.on ?? {}
  const violations: string[] = []
  const triggers = Object.keys(on).sort()
  if (triggers.join(',') !== 'release,workflow_dispatch') {
    violations.push(`unexpected triggers: ${triggers.join(', ')}`)
  }
  if (JSON.stringify(on.release?.types) !== JSON.stringify(['published'])) {
    violations.push('release must trigger on types [published] only')
  }
  if (on.workflow_dispatch?.inputs?.tag == null) {
    violations.push('workflow_dispatch must declare a tag input')
  }
  return violations
}

/** One `cli-release` concurrency group, never cancelling an in-flight run. */
function concurrencyViolations(workflow: Workflow): string[] {
  const violations: string[] = []
  if (workflow.concurrency?.group !== 'cli-release') {
    violations.push('concurrency group must be cli-release')
  }
  if (workflow.concurrency?.['cancel-in-progress'] !== false) {
    violations.push('cancel-in-progress must be false')
  }
  return violations
}

function indexOfStep(workflow: string, marker: string): number {
  const index = workflow.indexOf(marker)
  expect(index, `missing step: ${marker}`).toBeGreaterThan(-1)
  return index
}

describe('cli release workflow contract (Story 43.6 AC-5)', () => {
  it('runs only for published releases or an explicit manual recovery dispatch', () => {
    expect(triggerViolations(parseWorkflow(workflowText()))).toEqual([])
  })

  it.each<[string, string, string]>([
    ['a push trigger', '  release:\n', '  push:\n    tags: [v*]\n  release:\n'],
    ['another release type', 'types: [published]', 'types: [published, created]'],
    ['no tag input', '      tag:\n', '      ref:\n'],
  ])('the trigger check rejects a workflow with %s', (_label, from, to) => {
    const text = workflowText()
    expect(text).toContain(from)
    expect(triggerViolations(parseWorkflow(text.replace(from, to)))).not.toEqual([])
  })

  it('accepts only strict vMAJOR.MINOR.PATCH tags (same regex as container-publish)', () => {
    const workflow = workflowText()
    expect(workflow).toContain('^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$')
    expect(workflow).toMatch(/\$\{TAG#v\}/)
  })

  it('uses least privilege and no secret beyond GITHUB_TOKEN', () => {
    const workflow = workflowText()
    const secrets = [...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1])
    expect(new Set(secrets)).toEqual(new Set(['GITHUB_TOKEN']))
  })

  it('grants contents: write only to the upload job, never to the job that installs and runs code', () => {
    const workflow = workflowText()
    // No workflow-wide grant: every job states its own permissions.
    expect(workflow).toMatch(/^permissions: \{\}$/m)
    const jobs = workflow.slice(indexOfStep(workflow, '\njobs:\n'))
    const jobPermissions = (job: string): string => {
      const start = indexOfStep(jobs, `\n  ${job}:\n`)
      const next = jobs.slice(start + 1).search(/\n {2}[a-z][a-z-]*:\n/)
      const body = next === -1 ? jobs.slice(start) : jobs.slice(start, start + 1 + next)
      const match = /\n {4}permissions:(?: \{\}|\n((?: {6}[a-z-]+: [a-z]+\n)+))/.exec(body)
      expect(match, `job ${job} must declare permissions`).not.toBeNull()
      return (match?.[1] ?? '').trim()
    }
    expect(jobPermissions('release')).toBe('contents: read')
    expect(jobPermissions('verify')).toBe('')
    expect(jobPermissions('publish')).toBe('contents: write')
    expect(workflow.match(/^ +contents: write$/gm)).toHaveLength(1)
  })

  it('never persists the checkout token into the tree that dependencies and tests run in', () => {
    const workflow = workflowText()
    const checkouts = [...workflow.matchAll(/uses: actions\/checkout@[^\n]+\n((?: {8}.*\n)*)/g)]
    expect(checkouts.length).toBeGreaterThan(0)
    for (const [, withBlock] of checkouts) {
      expect(withBlock).toMatch(/persist-credentials: false/)
    }
  })

  it('serializes runs without cancelling (concurrency group cli-release)', () => {
    expect(concurrencyViolations(parseWorkflow(workflowText()))).toEqual([])
  })

  it.each<[string, string, string]>([
    ['another group', 'group: cli-release', 'group: cli-release-${{ github.ref }}'],
    ['cancel-in-progress true', 'cancel-in-progress: false', 'cancel-in-progress: true'],
    ['no concurrency block', '\nconcurrency:\n', '\nx-concurrency:\n'],
  ])('the concurrency check rejects a workflow with %s', (_label, from, to) => {
    const text = workflowText()
    expect(text).toContain(from)
    expect(concurrencyViolations(parseWorkflow(text.replace(from, to)))).not.toEqual([])
  })

  it('tests the unstamped tree, then stamps, builds, bundles, self-verifies and uploads in order', () => {
    const workflow = workflowText()
    const order = [
      'pnpm install --frozen-lockfile',
      'pnpm --filter "@project-vault/cli..." test',
      'scripts/stamp-build-info.ts --version',
      'pnpm --filter "@project-vault/cli..." build',
      'ncc build',
      'Self-verify --version',
      'sha256sum',
      'gh release upload',
    ].map((marker) => indexOfStep(workflow, marker))
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('bundles a single .mjs file without source maps and executes it directly', () => {
    const workflow = workflowText()
    expect(workflow).not.toContain('--source-map')
    expect(workflow).toMatch(/pvault-\$\{VERSION\}\.mjs/)
    expect(workflow).toMatch(/chmod \+x/)
    expect(workflow).toContain('./"$ASSET" --version')
  })

  it('self-verifies the exact --version lines, an empty stderr and no 0.0.1, on Node 20 and 24', () => {
    const workflow = workflowText()
    expect(workflow).toContain('pvault ${VERSION} (commit ${COMMIT})')
    expect(workflow).toContain('agent  ${VERSION} (commit ${COMMIT})')
    expect(workflow).toMatch(/node:\s*\['20',\s*'24'\]/)
    expect(workflow).toContain("grep -c '0\\.0\\.1'")
  })

  it('uploads the asset and its checksum with --clobber', () => {
    const workflow = workflowText()
    expect(workflow).toMatch(/gh release upload[^\n]*--clobber/)
    expect(workflow).toMatch(/\.sha256/)
  })
})
