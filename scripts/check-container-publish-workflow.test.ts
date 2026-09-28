import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The repository root has no YAML dependency; reuse the `yaml` package apps/api already depends on.
const { parse: parseYaml } = createRequire(resolve(process.cwd(), 'apps/api/package.json'))(
  'yaml'
) as typeof import('yaml')

// Read at transform time by Vite (vitest's module graph) as raw text: the lint-clean loading
// pattern check-action-pins.test.ts introduced (Story 64.2).
const WORKFLOW_TEXT: Record<string, string> = import.meta.glob(
  '../.github/workflows/container-publish.yml',
  { query: '?raw', import: 'default', eager: true }
)

function workflowText(): string {
  const text = Object.values(WORKFLOW_TEXT)[0]
  expect(text, 'container-publish.yml must be loadable').toBeDefined()
  return text ?? ''
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

// Story 64.3 AC-4/AC-5: a fixable HIGH/CRITICAL vulnerability in any pushed image, on either
// platform, must fail build-publish before promote-aliases can move `latest`/semver aliases.
describe('Story 64.3: release vulnerability gate before alias promotion', () => {
  type Step = {
    id?: string
    name?: string
    if?: unknown
    uses?: string
    with?: Record<string, unknown>
    env?: Record<string, unknown>
    'continue-on-error'?: unknown
  }
  type Job = { needs?: unknown; permissions?: unknown; steps?: Step[] }

  const jobs = (parseYaml(workflowText()) as { jobs: Record<string, Job> }).jobs
  const steps = jobs['build-publish']?.steps ?? []
  const scans = steps.filter((step) => step.uses?.startsWith('aquasecurity/trivy-action@'))
  const pushIndex = steps.findIndex((step) => step.id === 'push')
  const verifyIndex = steps.findIndex((step) =>
    /Verify published image version matches the release tag/.test(step.name ?? '')
  )

  it('(a) scans in build-publish, after the push and the version verification', () => {
    expect(scans.length).toBeGreaterThan(0)
    expect(pushIndex).toBeGreaterThan(-1)
    expect(verifyIndex).toBeGreaterThan(pushIndex)
    for (const scan of scans) expect(steps.indexOf(scan)).toBeGreaterThan(verifyIndex)
  })

  it('(b) scans the exact pushed digest of this matrix image', () => {
    for (const scan of scans) {
      const ref = String(scan.with?.['image-ref'])
      expect(ref).toMatch(/\$\{\{\s*env\.IMAGE_NAMESPACE\s*\}\}\/\$\{\{\s*matrix\.name\s*\}\}@/)
      expect(ref).toMatch(/@\$\{\{\s*steps\.push\.outputs\.digest\s*\}\}$/)
    }
  })

  it('(b) covers both published platforms, and one failing platform does not mask the other', () => {
    const platforms = scans.map((scan) => scan.env?.TRIVY_PLATFORM).sort()
    // Exactly the platforms the push step published, so adding one without a scan fails here.
    const published = String(steps.find((step) => step.id === 'push')?.with?.platforms ?? '')
      .split(',')
      .map((platform) => platform.trim())
      .sort()
    expect(published.length).toBeGreaterThanOrEqual(2)
    expect(platforms).toEqual(published)
    for (const scan of scans.slice(1)) expect(String(scan.if)).toMatch(/!\s*cancelled\(\)/)
    for (const scan of scans) {
      // Only scan a digest that was actually pushed, never an empty `name@` reference.
      expect(String(scan.if ?? "steps.push.outcome == 'success'")).toMatch(
        /steps\.push\.outcome == 'success'/
      )
    }
  })

  it('(c) fails the job on findings and honours .trivyignore with the PR-gate settings', () => {
    for (const scan of scans) {
      expect(scan.with?.['exit-code']).toBe('1')
      expect(scan['continue-on-error']).toBe(undefined)
      expect(scan.with?.trivyignores).toBe('.trivyignore')
      expect(scan.with?.severity).toBe('CRITICAL,HIGH')
      expect(scan.with?.['ignore-unfixed']).toBe(true)
      expect(scan.with?.['vuln-type']).toBe('os,library')
    }
  })

  it('pulls from GHCR with the job token only: no new secret, no wider permissions', () => {
    for (const scan of scans) {
      expect(String(scan.env?.TRIVY_USERNAME)).toMatch(/^\$\{\{\s*github\.actor\s*\}\}$/)
      expect(String(scan.env?.TRIVY_PASSWORD)).toMatch(/^\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}$/)
    }
    expect(jobs['build-publish']?.permissions).toEqual({
      contents: 'read',
      packages: 'write',
      attestations: 'write',
      'id-token': 'write',
    })
    expect(
      workflowText()
        .match(/secrets\.(\w+)/g)
        ?.every((ref) => ref === 'secrets.GITHUB_TOKEN')
    ).toBe(true)
  })

  it('(d) promote-aliases still needs build-publish, so a failed gate moves no alias', () => {
    expect(jobs['promote-aliases']?.needs).toEqual(['prepare', 'build-publish'])
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

  // The fixture reaches the script through an env var rather than a temp file, so nothing is
  // written to disk and nothing needs cleaning up.
  const script = bodyLines
    .join('\n')
    .replace(
      /INSPECT_JSON=\$\(docker buildx imagetools inspect[^\n]*\)/,
      'INSPECT_JSON="$STUB_INSPECT_JSON"'
    )
  expect(script, 'imagetools inspect call must be stubbable').toContain(
    'INSPECT_JSON="$STUB_INSPECT_JSON"'
  )

  const run = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      IMAGE_NAMESPACE: 'ghcr.io/example/project-vault',
      IMAGE_NAME: options.imageName,
      VERSION: options.version,
      STUB_INSPECT_JSON: JSON.stringify(options.inspectJson),
      // Built rather than inlined so the fixture digest is not flagged as a leaked hash.
      DIGEST: `sha256:${'0'.repeat(64)}`,
    },
  })

  return { status: run.status ?? -1, output: `${run.stdout}${run.stderr}` }
}
