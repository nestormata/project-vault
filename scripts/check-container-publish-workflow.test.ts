import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const workflowPath = resolve(process.cwd(), '.github/workflows/container-publish.yml')

// runVerifyStep() writes one fixture per call and is invoked once per verification-step test, so
// without this the suite leaks a temp directory into tmpdir on every `make ci` run.
const tempDirs: string[] = []

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

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
    expect(workflow).toMatch(/target:\s*migrate/)
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

  it('uses the release tag as the checkout ref and stamps one resolved source commit', () => {
    const workflow = workflowText()

    expect(workflow).toMatch(/group:\s*container-publish-aliases/)
    expect(workflow).toMatch(/commit:\s*\$\{\{\s*steps\.source\.outputs\.commit\s*\}\}/)
    expect(workflow).toMatch(/ref:\s*\$\{\{\s*needs\.prepare\.outputs\.ref\s*\}\}/)
    expect(workflow).not.toMatch(/ref:\s*\$\{\{\s*needs\.prepare\.outputs\.commit\s*\}\}/)
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

  // Story 9.10 AC-2: the workflow must inject RELEASE_VERSION as a build-arg, stamp the OCI
  // version label, and verify both the pushed label and the baked-in runtime value agree with
  // the release tag before promote-aliases can create/move any alias tag.
  describe('Story 9.10: release-version injection and verification', () => {
    it('passes RELEASE_VERSION as a build-arg sourced from the validated release tag', () => {
      const workflow = workflowText()

      expect(workflow).toMatch(
        /build-args:\s*\|?\s*\n?\s*RELEASE_VERSION=\$\{\{\s*needs\.prepare\.outputs\.version\s*\}\}/
      )
    })

    it('stamps the OCI org.opencontainers.image.version label from the release tag', () => {
      const workflow = workflowText()

      expect(workflow).toMatch(
        /org\.opencontainers\.image\.version=\$\{\{\s*needs\.prepare\.outputs\.version\s*\}\}/
      )
    })

    it('runs a post-push version-verification step before promote-aliases can run', () => {
      const workflow = workflowText()

      const buildPublishJob = workflow.match(
        /\n  build-publish:[\s\S]*?(?=\n  promote-aliases:)/
      )?.[0]
      expect(buildPublishJob).toBeDefined()
      expect(buildPublishJob).toMatch(/Verify (published |pushed )?(image )?(release )?version/i)
      // The verification step must appear after "Attest image provenance" and the job as a
      // whole must be a dependency of promote-aliases (already asserted elsewhere), so a
      // mismatch fails the run before any alias tag is created/moved.
      const attestIndex = buildPublishJob?.indexOf('Attest image provenance') ?? -1
      const verifyIndex =
        buildPublishJob?.search(/Verify (published |pushed )?(image )?(release )?version/i) ?? -1
      expect(attestIndex).toBeGreaterThan(-1)
      expect(verifyIndex).toBeGreaterThan(attestIndex)
    })

    // These execute the verification step's actual shell body against stubbed
    // `imagetools inspect` output instead of grepping the YAML for substrings. A grep-only test
    // passed while the step was in fact dead on arrival: its jq read the Go-template field names
    // (`.Image.Config`) even though the JSON document uses lowercase keys (`.image`, `.config`),
    // so `null | to_entries` aborted the step on every release.
    describe('verification step behavior', () => {
      const platformImage = (label: string | null, releaseVersion: string | null) => ({
        config: {
          ...(label === null ? {} : { Labels: { 'org.opencontainers.image.version': label } }),
          Env: [
            'PATH=/usr/local/bin',
            ...(releaseVersion === null ? [] : [`RELEASE_VERSION=${releaseVersion}`]),
          ],
        },
      })

      it('accepts a multi-platform manifest whose every platform matches the release tag', () => {
        const result = runVerifyStep({
          imageName: 'api',
          version: '1.0.2',
          inspectJson: {
            image: {
              'linux/amd64': platformImage('1.0.2', '1.0.2'),
              'linux/arm64': platformImage('1.0.2', '1.0.2'),
              // provenance/sbom attestation manifests carry no image config and must be skipped.
              'unknown/unknown': { config: {} },
            },
          },
        })

        expect(result.status).toBe(0)
        expect(result.output).toContain('linux/amd64')
        expect(result.output).toContain('linux/arm64')
      })

      it('accepts the single-platform inspect shape, where .image is the config itself', () => {
        const result = runVerifyStep({
          imageName: 'api',
          version: '1.0.2',
          inspectJson: { image: platformImage('1.0.2', '1.0.2') },
        })

        expect(result.status).toBe(0)
      })

      it('fails on an OCI label mismatch, naming both disagreeing values', () => {
        const result = runVerifyStep({
          imageName: 'web',
          version: '1.0.2',
          inspectJson: { image: { 'linux/amd64': platformImage('1.0.1', null) } },
        })

        expect(result.status).toBe(1)
        expect(result.output).toContain("is '1.0.1'")
        expect(result.output).toContain("expected '1.0.2'")
      })

      it('fails on a missing OCI label rather than passing an empty value through', () => {
        const result = runVerifyStep({
          imageName: 'migrate',
          version: '1.0.2',
          inspectJson: { image: { 'linux/amd64': platformImage(null, null) } },
        })

        expect(result.status).toBe(1)
        expect(result.output).toMatch(/org\.opencontainers\.image\.version/)
      })

      it('fails on a baked runtime RELEASE_VERSION mismatch in the api image', () => {
        const result = runVerifyStep({
          imageName: 'api',
          version: '1.0.2',
          inspectJson: { image: { 'linux/amd64': platformImage('1.0.2', 'dev') } },
        })

        expect(result.status).toBe(1)
        expect(result.output).toContain('baked-in runtime RELEASE_VERSION')
      })

      it('fails when a non-first platform disagrees, not just the first one', () => {
        const result = runVerifyStep({
          imageName: 'api',
          version: '1.0.2',
          inspectJson: {
            image: {
              'linux/amd64': platformImage('1.0.2', '1.0.2'),
              'linux/arm64': platformImage('1.0.2', 'dev'),
            },
          },
        })

        expect(result.status).toBe(1)
        expect(result.output).toContain('linux/arm64')
      })

      it('fails with a clear diagnostic when no image config is readable at all', () => {
        const result = runVerifyStep({
          imageName: 'api',
          version: '1.0.2',
          inspectJson: { image: { 'unknown/unknown': { config: {} } } },
        })

        expect(result.status).toBe(1)
        expect(result.output).toMatch(/no readable image config/)
      })

      it('does not require a runtime RELEASE_VERSION for images that never run the app', () => {
        for (const imageName of ['migrate', 'web']) {
          const result = runVerifyStep({
            imageName,
            version: '1.0.2',
            inspectJson: { image: { 'linux/amd64': platformImage('1.0.2', null) } },
          })

          expect(result.status, `${imageName} should pass on label alone`).toBe(0)
        }
      })
    })
  })
})

/**
 * Extracts the `run:` body of the "Verify published image version matches the release tag" step
 * from the real workflow file and executes it with `docker buildx imagetools inspect` replaced by
 * a fixture, so the step's actual jq/bash logic is under test rather than its source text.
 */
function runVerifyStep(options: { imageName: string; version: string; inspectJson: unknown }): {
  status: number
  output: string
} {
  const workflow = workflowText()
  const stepMarker = '- name: Verify published image version matches the release tag'
  const stepStart = workflow.indexOf(stepMarker)
  expect(stepStart, 'verification step must exist in the workflow').toBeGreaterThan(-1)

  const afterRun = workflow.slice(workflow.indexOf('run: |', stepStart) + 'run: |'.length)
  const bodyLines: string[] = []
  for (const line of afterRun.split('\n').slice(1)) {
    // The body is indented 10 spaces under `run: |`; the first line at a shallower indent ends it.
    if (line.trim() !== '' && !line.startsWith(' '.repeat(10))) break
    bodyLines.push(line.slice(10))
  }

  const stubDir = mkdtempSync(join(tmpdir(), 'verify-step-'))
  tempDirs.push(stubDir)
  const stubPath = join(stubDir, 'inspect.json')
  writeFileSync(stubPath, JSON.stringify(options.inspectJson))
  const script = bodyLines
    .join('\n')
    .replace(
      /INSPECT_JSON=\$\(docker buildx imagetools inspect[^\n]*\)/,
      `INSPECT_JSON=$(cat ${JSON.stringify(stubPath)})`
    )
  expect(script, 'imagetools inspect call must be stubbable').toContain('INSPECT_JSON=$(cat ')

  const run = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      IMAGE_NAMESPACE: 'ghcr.io/example/project-vault',
      IMAGE_NAME: options.imageName,
      VERSION: options.version,
      // Built rather than inlined so the fixture digest is not flagged as a leaked hash.
      DIGEST: `sha256:${'0'.repeat(64)}`,
    },
  })

  return { status: run.status ?? -1, output: `${run.stdout}${run.stderr}` }
}
