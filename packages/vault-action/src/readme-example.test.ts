import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const README_PATH = fileURLToPath(new URL('../README.md', import.meta.url))

/** Extracts the content of every ```yaml fenced code block in a Markdown document, in order. */
function extractYamlBlocks(markdown: string): string[] {
  const blocks: string[] = []
  const regex = /```yaml\n([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(markdown)) !== null) {
    const block = match[1]
    if (block) blocks.push(block)
  }
  return blocks
}

describe('README.md example workflow (AC-13)', () => {
  const readme = readFileSync(README_PATH, 'utf-8')
  const yamlBlocks = extractYamlBlocks(readme)

  it('contains at least one fenced yaml block', () => {
    expect(yamlBlocks.length).toBeGreaterThan(0)
  })

  it('every fenced yaml block in the README parses as valid YAML', () => {
    for (const block of yamlBlocks) {
      expect(() => parse(block)).not.toThrow()
    }
  })

  it('has a complete, copy-pasteable example workflow with a valid top-level shape', () => {
    const workflowBlock = yamlBlocks.find((block) => {
      const parsed = parse(block) as Record<string, unknown> | null
      return Boolean(parsed && typeof parsed === 'object' && 'jobs' in parsed && 'on' in parsed)
    })

    expect(workflowBlock).toBeDefined()
    const parsed = parse(workflowBlock as string) as {
      name?: string
      on?: unknown
      jobs: Record<
        string,
        { 'runs-on': string; steps: { uses?: string; with?: Record<string, unknown> }[] }
      >
    }

    expect(parsed.name).toBeTruthy()
    expect(parsed.on).toBeTruthy()
    const jobNames = Object.keys(parsed.jobs)
    expect(jobNames.length).toBeGreaterThan(0)

    const allSteps = jobNames.flatMap((jobName) => parsed.jobs[jobName]?.steps ?? [])
    const actionStep = allSteps.find((step) => step.uses?.startsWith('nestormata/vault-action@'))
    expect(actionStep).toBeDefined()
    expect(actionStep?.with).toMatchObject({
      'vault-url': expect.any(String),
      'api-key': expect.any(String),
      secrets: expect.any(String),
    })
  })

  it('documents all four action inputs at least once each', () => {
    for (const input of ['vault-url', 'api-key', 'secrets', 'continue-on-error']) {
      expect(readme).toContain(input)
    }
  })

  it('documents the D2 one-project-per-step constraint', () => {
    expect(readme.toLowerCase()).toContain('one project')
  })

  it("documents the continue-on-error naming collision with GitHub's own step-level key", () => {
    expect(readme).toMatch(/naming.collision/i)
  })

  it('documents SHA-pinning as a hardened alternative to @v1', () => {
    expect(readme).toMatch(/full-commit-sha/)
  })

  it('documents the matrix/parallel-job rate-limit consideration', () => {
    expect(readme.toLowerCase()).toContain('matrix')
    expect(readme.toLowerCase()).toContain('rate limit')
  })

  it('documents the v1 GitLab CI workaround', () => {
    expect(readme).toMatch(/GitLab CI/)
    expect(readme).toContain('machine-token')
  })
})
