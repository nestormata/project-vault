import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Story 43.6 AC-5 — the `pvault` release workflow's contract. */
const workflowPath = resolve(process.cwd(), '.github/workflows/cli-release.yml')

function workflowText(): string {
  return readFileSync(workflowPath, 'utf8')
}

function indexOfStep(workflow: string, marker: string): number {
  const index = workflow.indexOf(marker)
  expect(index, `missing step: ${marker}`).toBeGreaterThan(-1)
  return index
}

describe('cli release workflow contract (Story 43.6 AC-5)', () => {
  it('runs only for published releases or an explicit manual recovery dispatch', () => {
    const workflow = workflowText()
    expect(workflow).toMatch(/release:\s*\n\s*types:\s*\[published\]/)
    expect(workflow).toMatch(/workflow_dispatch:\s*\n\s*inputs:\s*\n\s*tag:/)
    expect(workflow).not.toMatch(/push:\s*\n\s*(branches|tags):/)
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
    const workflow = workflowText()
    expect(workflow).toMatch(
      /concurrency:\s*\n\s*group:\s*cli-release\s*\n\s*cancel-in-progress:\s*false/
    )
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
