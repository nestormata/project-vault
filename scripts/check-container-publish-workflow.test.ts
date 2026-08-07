import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const workflowPath = resolve(process.cwd(), '.github/workflows/container-publish.yml')

function workflowText(): string {
  return readFileSync(workflowPath, 'utf8')
}

describe('container publish workflow contract', () => {
  it('publishes only from releases or an explicit manual recovery dispatch', () => {
    const workflow = workflowText()

    expect(workflow).toMatch(/release:\s*\n\s*types:\s*\[published\]/)
    expect(workflow).toMatch(/workflow_dispatch:/)
    expect(workflow).toMatch(/tag:\s*\n\s*description:/)
    expect(workflow).not.toMatch(/push:\s*\n\s*(branches|tags):/)
    expect(workflow).toMatch(/refs\/heads\/main/)
    expect(workflow).toMatch(/0\|\[1-9\]\[0-9\]\*\)/)
  })

  it('uses least-privilege GitHub and registry permissions', () => {
    const workflow = workflowText()

    expect(workflow).toMatch(/contents:\s*read/)
    expect(workflow).toMatch(/packages:\s*write/)
    expect(workflow).toMatch(/attestations:\s*write/)
    expect(workflow).toMatch(/id-token:\s*write/)
    expect(workflow).toMatch(/password:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/)
  })

  it('builds all three images for both supported runtime platforms', () => {
    const workflow = workflowText()

    expect(workflow).toMatch(/linux\/amd64,linux\/arm64/)
    expect(workflow).toMatch(/name:\s*api/)
    expect(workflow).toMatch(/name:\s*migrate/)
    expect(workflow).toMatch(/name:\s*web/)
    expect(workflow).toMatch(/file:\s*apps\/api\/Dockerfile/)
    expect(workflow).toMatch(/file:\s*apps\/web\/Dockerfile/)
    expect(workflow).toMatch(/target:\s*db-builder/)
    expect(workflow).toMatch(/push:\s*true/)
  })

  it('publishes immutable release/SHA tags before promoting aliases', () => {
    const workflow = workflowText()

    expect(workflow).toMatch(/type=raw,value=\$\{\{\s*needs\.prepare\.outputs\.version\s*\}\}/)
    expect(workflow).toMatch(/type=sha,format=long,prefix=sha-/)
    expect(workflow).toMatch(/promote-aliases:/)
    expect(workflow).toMatch(/needs:\s*\[prepare, build-publish\]/)
    expect(workflow).toMatch(/imagetools create/)
    expect(workflow).toMatch(/latest/)
    expect(workflow).toMatch(/git ls-remote --exit-code/)
    expect(workflow).toMatch(/imagetools inspect/)
  })

  it('uses one resolved source commit and serializes shared aliases', () => {
    const workflow = workflowText()

    expect(workflow).toMatch(/group:\s*container-publish-aliases/)
    expect(workflow).toMatch(/commit:\s*\$\{\{\s*steps\.source\.outputs\.commit\s*\}\}/)
    expect(workflow).toMatch(/ref:\s*\$\{\{\s*needs\.prepare\.outputs\.commit\s*\}\}/)
    expect(workflow).toMatch(
      /org\.opencontainers\.image\.revision=\$\{\{\s*needs\.prepare\.outputs\.commit\s*\}\}/
    )
  })

  it('includes BuildKit caching and supply-chain metadata', () => {
    const workflow = workflowText()

    expect(workflow).toMatch(/cache-from:\s*type=gha/)
    expect(workflow).toMatch(/cache-to:\s*type=gha,mode=max/)
    expect(workflow).toMatch(/provenance:\s*mode=max/)
    expect(workflow).toMatch(/sbom:\s*true/)
  })
})
