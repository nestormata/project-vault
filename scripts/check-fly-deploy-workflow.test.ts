import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const deployWorkflowPath = resolve(process.cwd(), '.github/workflows/fly-deploy.yml')
const bootstrapWorkflowPath = resolve(process.cwd(), '.github/workflows/fly-bootstrap.yml')
const resetWorkflowPath = resolve(process.cwd(), '.github/workflows/fly-reset.yml')

function readWorkflow(path: string): string {
  return readFileSync(path, 'utf8')
}

describe('Fly demo deployment workflow contract', () => {
  it('deploys only published strict-semver releases or an explicitly selected release tag', () => {
    const workflow = readWorkflow(deployWorkflowPath)

    expect(workflow).toMatch(/release:\s*\n\s*types:\s*\[published\]/)
    expect(workflow).toMatch(/workflow_dispatch:\s*\n\s*inputs:/)
    expect(workflow).toMatch(/tag:\s*\n\s*description:/)
    expect(workflow).toMatch(/required:\s*true/)
    expect(workflow).toMatch(/type:\s*string/)
    expect(workflow).not.toMatch(/push:\s*\n/)
    expect(workflow).toMatch(/v\(0\|\[1-9\]\[0-9\]\*\)\\\./)
    expect(workflow).toMatch(/git ls-remote --exit-code/)
  })

  it('checks out the resolved release ref before building the Fly images', () => {
    const workflow = readWorkflow(deployWorkflowPath)

    expect(workflow).toMatch(/ref:\s*\$\{\{\s*needs\.prepare\.outputs\.ref\s*\}\}/)
    expect(workflow).toMatch(/prepare:\s*\n/)
    expect(workflow).toMatch(/needs:\s*prepare/)
    expect(workflow).toMatch(/needs\.prepare\.outputs\.ref/)
    expect(workflow).toMatch(
      /--build-arg\s+RELEASE_VERSION=\$\{\{\s*needs\.prepare\.outputs\.version\s*\}\}/
    )
    expect(workflow).not.toMatch(/actions\/checkout@v7\s*\n(?!\s+with:)/)
  })

  it('does not allow bootstrap to deploy the workflow default branch', () => {
    const workflow = readWorkflow(bootstrapWorkflowPath)

    expect(workflow).toMatch(/release_tag:/)
    expect(workflow).toMatch(/required:\s*true/)
    expect(workflow).toMatch(/ref:\s*\$\{\{\s*inputs\.release_tag\s*\}\}/)
    expect(workflow).toMatch(/v\(0\|\[1-9\]\[0-9\]\*\)\\\./)
    expect(workflow).toMatch(/git ls-remote --exit-code/)
  })

  it('runs scheduled and manual resets from a resolved release ref', () => {
    const workflow = readWorkflow(resetWorkflowPath)

    expect(workflow).toMatch(/schedule:/)
    expect(workflow).toMatch(/workflow_dispatch:\s*\n\s*inputs:/)
    expect(workflow).toMatch(/tag:\s*\n\s*description:/)
    expect(workflow).toMatch(/releases\/latest/)
    expect(workflow).toMatch(/git ls-remote --exit-code/)
    expect(workflow).toMatch(/prepare:\s*\n/)
    expect(workflow).toMatch(/ref:\s*\$\{\{\s*needs\.prepare\.outputs\.ref\s*\}\}/)
    expect(workflow).toMatch(/needs:\s*prepare/)
  })
})
