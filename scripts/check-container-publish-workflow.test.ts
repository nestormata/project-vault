import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  RELEASE_IMAGE_NAMESPACE_EXPRESSION,
  RELEASE_IMAGE_NAME_EXPRESSION,
} from './lib/release-image.js'

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

    expect(workflow).toMatch(/platforms:\s*linux\/\$\{\{\s*matrix\.platform\.arch\s*\}\}/)
    expect(workflow).toMatch(/arch:\s*amd64/)
    expect(workflow).toMatch(/arch:\s*arm64/)
    expect(workflow).toMatch(/name:\s*api/)
    expect(workflow).toMatch(/name:\s*migrate/)
    expect(workflow).toMatch(/name:\s*web/)
    expect(workflow).toMatch(/file:\s*apps\/api\/Dockerfile/)
    expect(workflow).toMatch(/file:\s*apps\/web\/Dockerfile/)
    expect(workflow).toMatch(/target:\s*migrate/)
    expect(workflow).toMatch(/push=true/)
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

  // Story 68.2 AC-9: the web-host compatibility manifest's apiImageTag is computed by
  // scripts/lib/release-image.ts. This pins the workflow to the same derivation, so the two can never
  // name different images: <IMAGE_NAMESPACE>/<name>:<release version>.
  it('tags images exactly as scripts/lib/release-image.ts derives the apiImageTag', () => {
    const workflow = workflowText()
    const parsed = parseYaml(workflow) as { env?: Record<string, string> }

    expect(parsed.env?.IMAGE_NAMESPACE).toBe(RELEASE_IMAGE_NAMESPACE_EXPRESSION)
    expect(workflow).toContain(`images: ${RELEASE_IMAGE_NAME_EXPRESSION}`)
    expect(workflow).toMatch(/type=raw,value=\$\{\{\s*needs\.prepare\.outputs\.version\s*\}\}/)
    expect(workflow).toContain('echo "version=${TAG#v}"')
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

const BUILD_PUBLISH = 'build-publish'
const BUILD_PLATFORM = 'build-platform'

type PublishJob = {
  needs?: unknown
  if?: unknown
  'runs-on'?: string
  permissions?: unknown
  strategy?: {
    'fail-fast'?: unknown
    matrix?: {
      image?: { name: string; file: string; target: string }[]
      platform?: { arch: string; runner: string }[]
      name?: string[]
    }
  }
  steps?: {
    id?: string
    name?: string
    uses?: string
    run?: string
    with?: Record<string, unknown>
    'continue-on-error'?: unknown
  }[]
}

function jobNamed(name: string, text: string = workflowText()): PublishJob | undefined {
  return Object.entries(parsedJobs(text)).find(([jobName]) => jobName === name)?.[1]
}

function parsedJobs(text: string = workflowText()): Record<string, PublishJob> {
  return (parseYaml(text) as { jobs: Record<string, PublishJob> }).jobs
}

const PLATFORM_ARCHES = (jobNamed(BUILD_PLATFORM)?.strategy?.matrix?.platform ?? []).map(
  (platform) => platform.arch
)

/** True only for a literal `strategy.fail-fast: false`; anything else counts as fail-fast. */
function failFastDisabled(text: string, job: string): boolean {
  return (
    Object.entries(parsedJobs(text)).find(([name]) => name === job)?.[1].strategy?.['fail-fast'] ===
    false
  )
}

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
  const steps = jobNamed(BUILD_PUBLISH)?.steps ?? []
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
    const published = PLATFORM_ARCHES.map((arch) => `linux/${arch}`).sort()
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
    // Auth comes from the ghcr.io-scoped Docker config the login step writes; explicit Trivy
    // credentials would be offered to every registry Trivy contacts (its DB mirrors included).
    for (const scan of scans) {
      expect(scan.env?.TRIVY_USERNAME).toBe(undefined)
      expect(scan.env?.TRIVY_PASSWORD).toBe(undefined)
    }
    expect(jobNamed(BUILD_PUBLISH)?.permissions).toEqual({
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
    expect(jobs['promote-aliases']?.needs).toEqual(['prepare', BUILD_PUBLISH])
  })
})

// Story 75.1: platform builds run on native runners and push by digest only; the immutable tags
// are created by build-publish after BOTH platform digests exist, so a failed platform leaves no tag
// and "re-run failed jobs" can always recover the run (v2.0.1, run 41269218945).
describe('Story 75.1: native platform builds and a tag-after-both-platforms merge', () => {
  const jobs = parsedJobs()
  const build = jobNamed(BUILD_PLATFORM)
  const publish = jobNamed(BUILD_PUBLISH)
  const buildSteps = build?.steps ?? []
  const publishSteps = publish?.steps ?? []

  it('keeps strategy.fail-fast: false on both matrix jobs, and the check fails on a mutation', () => {
    expect(failFastDisabled(workflowText(), BUILD_PLATFORM)).toBe(true)
    expect(failFastDisabled(workflowText(), BUILD_PUBLISH)).toBe(true)

    const mutatedToTrue = workflowText().replace(/fail-fast: false/g, 'fail-fast: true')
    const mutatedRemoved = workflowText().replace(/ *fail-fast: false\n/g, '')
    for (const mutated of [mutatedToTrue, mutatedRemoved]) {
      expect(failFastDisabled(mutated, BUILD_PLATFORM)).toBe(false)
      expect(failFastDisabled(mutated, BUILD_PUBLISH)).toBe(false)
    }
  })

  it('builds each platform on a native runner, with no QEMU emulation anywhere', () => {
    expect(build?.strategy?.matrix?.platform).toEqual([
      { arch: 'amd64', runner: 'ubuntu-24.04' },
      { arch: 'arm64', runner: 'ubuntu-24.04-arm' },
    ])
    expect(build?.['runs-on']).toBe('${{ matrix.platform.runner }}')
  })

  it('has no QEMU or binfmt emulation step in any job', () => {
    for (const job of Object.values(jobs)) {
      for (const step of job.steps ?? []) {
        expect(step.uses ?? '').not.toMatch(/qemu/i)
        expect(step.run ?? '').not.toMatch(/qemu|binfmt/i)
      }
    }
  })

  it('builds and publishes the same three images', () => {
    const built = (build?.strategy?.matrix?.image ?? []).map((image) => image.name)
    expect(built).toEqual(['api', 'migrate', 'web'])
    expect(publish?.strategy?.matrix?.name).toEqual(built)
  })

  it('pushes each platform by digest only: no tag can exist before the merge', () => {
    const buildStep = buildSteps.find((step) => step.id === 'build')
    const inputs = buildStep?.with ?? {}
    expect(buildStep?.uses).toMatch(/^docker\/build-push-action@[0-9a-f]{40}$/)
    expect(String(inputs.outputs)).toMatch(/push-by-digest=true/)
    expect(String(inputs.outputs)).toMatch(/name-canonical=true/)
    expect(String(inputs.outputs)).toMatch(/push=true/)
    expect(inputs.tags).toBe(undefined)
    expect(inputs.push).toBe(undefined)
    expect(inputs.platforms).toBe('linux/${{ matrix.platform.arch }}')
  })

  it('creates no tag and no manifest anywhere in build-platform', () => {
    for (const step of buildSteps) {
      expect(String(step.with?.tags ?? '')).not.toMatch(/type=raw|type=sha/)
      expect(step.run ?? '').not.toMatch(/imagetools create/)
      expect(step.id).not.toBe('push')
    }
  })

  it('creates the immutable tags in build-publish only, which needs every platform build', () => {
    expect(publish?.needs).toEqual(['prepare', BUILD_PLATFORM])
    // No `if:` (so no `!cancelled()`/`always()`): the default success() skips the job when any
    // platform leg failed, which is what keeps `:X.Y.Z` absent.
    expect(publish?.if).toBe(undefined)
    const createIndex = publishSteps.findIndex((step) => step.id === 'push')
    expect(publishSteps.at(createIndex)?.run).toMatch(/imagetools create/)
    const rejectIndex = publishSteps.findIndex((step) =>
      /Reject existing immutable release tag/.test(step.name ?? '')
    )
    expect(rejectIndex).toBeGreaterThan(-1)
    expect(createIndex).toBeGreaterThan(rejectIndex)
  })

  it('ties the uploaded digest artifact names to the download pattern', () => {
    const upload = buildSteps.find((step) => /^actions\/upload-artifact@/.test(step.uses ?? ''))
    const download = publishSteps.find((step) =>
      /^actions\/download-artifact@/.test(step.uses ?? '')
    )
    expect(upload?.with?.name).toBe('digest-${{ matrix.image.name }}-${{ matrix.platform.arch }}')
    expect(download?.with?.pattern).toBe('digest-${{ matrix.name }}-*')
    expect(download?.with?.['merge-multiple']).toBe(true)
    expect(upload?.with?.overwrite).toBe(true)
  })

  it('requires exactly one digest per published platform before it creates any tag', () => {
    const expected = /EXPECTED_DIGESTS: '(\d+)'/.exec(workflowText())?.[1]
    expect(Number(expected)).toBe(PLATFORM_ARCHES.length)
    expect(Number(expected)).toBeGreaterThanOrEqual(2)
  })

  it('hides no failure: no continue-on-error and no retry loop', () => {
    expect(workflowText()).not.toMatch(/continue-on-error/)
    expect(workflowText()).not.toMatch(/nick-fields\/retry|until docker|while true/)
  })

  it('keeps least-privilege permissions on the platform build job', () => {
    expect(build?.permissions).toEqual({ contents: 'read', packages: 'write' })
  })

  it('attests, verifies and scans the merged manifest-list digest, in that order', () => {
    const indexOf = (pattern: RegExp) => publishSteps.findIndex((s) => pattern.test(s.name ?? ''))
    const create = publishSteps.findIndex((step) => step.id === 'push')
    const attest = indexOf(/Attest image provenance/)
    const verify = indexOf(/Verify published image version/)
    const scanAmd = indexOf(/\(linux\/amd64\)/)
    const scanArm = indexOf(/\(linux\/arm64\)/)
    expect([create, attest, verify, scanAmd, scanArm].every((i) => i > -1)).toBe(true)
    expect(create).toBeLessThan(attest)
    expect(attest).toBeLessThan(verify)
    expect(verify).toBeLessThan(scanAmd)
    expect(scanAmd).toBeLessThan(scanArm)
    expect(publishSteps.at(attest)?.with?.['subject-digest']).toBe(
      '${{ steps.push.outputs.digest }}'
    )
  })

  describe('merge step behavior (real shell body, stubbed docker)', () => {
    const SHA_A = 'a'.repeat(64)
    const SHA_B = 'b'.repeat(64)
    const INDEX_DIGEST = `sha256:${'c'.repeat(64)}`
    const TAGS = 'ghcr.io/example/p/api:2.0.3\nghcr.io/example/p/api:sha-0123'

    it('creates both tags from both platform digests and reports the index digest', () => {
      const result = runCreateStep({ digests: [SHA_A, SHA_B], tags: TAGS })

      expect(result.status).toBe(0)
      expect(result.docker).toContain('create')
      expect(result.docker).toContain('--tag ghcr.io/example/p/api:2.0.3')
      expect(result.docker).toContain('--tag ghcr.io/example/p/api:sha-0123')
      expect(result.docker).toContain(`ghcr.io/example/p/api@sha256:${SHA_A}`)
      expect(result.docker).toContain(`ghcr.io/example/p/api@sha256:${SHA_B}`)
      expect(result.githubOutput).toBe(`digest=${INDEX_DIGEST}\n`)
    })

    it('creates NO tag when a platform digest is missing (a failed platform leg)', () => {
      const result = runCreateStep({ digests: [SHA_A], tags: TAGS })

      expect(result.status).toBe(1)
      expect(result.output).toMatch(/refusing to create any tag/)
      expect(result.docker).not.toContain('create')
    })

    it('creates NO tag when there are more digests than platforms, or none', () => {
      for (const digests of [[], [SHA_A, SHA_B, 'd'.repeat(64)]]) {
        const result = runCreateStep({ digests, tags: TAGS })
        expect(result.status).toBe(1)
        expect(result.docker).not.toContain('create')
      }
    })

    it('rejects a digest file name that is not 64 lowercase hex characters', () => {
      const result = runCreateStep({ digests: [SHA_A, 'not-a-digest'], tags: TAGS })

      expect(result.status).toBe(1)
      expect(result.output).toMatch(/Unexpected platform digest file name/)
      expect(result.docker).not.toContain('create')
    })

    it('fails when the merged manifest digest cannot be read back', () => {
      const result = runCreateStep({ digests: [SHA_A, SHA_B], tags: TAGS, inspectJson: {} })

      expect(result.status).toBe(1)
      expect(result.output).toMatch(/Cannot read the manifest-list digest/)
    })

    function runCreateStep(options: { digests: string[]; tags: string; inspectJson?: unknown }): {
      status: number
      output: string
      docker: string
      githubOutput: string
    } {
      const body = stepRunBody('- name: Create multi-platform manifest and push immutable tags')
      const dir = mkdtempSync(join(tmpdir(), 'pv-merge-step-'))
      try {
        const digestDir = join(dir, 'digests')
        mkdirSync(digestDir)
        for (const digest of options.digests) writeFileSync(join(digestDir, digest), '')
        const dockerLog = join(dir, 'docker.log')
        const githubOutput = join(dir, 'github-output')
        writeFileSync(dockerLog, '')
        writeFileSync(githubOutput, '')
        // A shell function shadows the docker CLI: it logs every call and answers `inspect`.
        const stub =
          'docker() {\n' +
          '  echo "$*" >> "$DOCKER_LOG"\n' +
          '  if [[ "$3" == inspect ]]; then printf "%s" "$STUB_INSPECT_JSON"; fi\n' +
          '}\n'
        const run = spawnSync('bash', ['-c', stub + body], {
          encoding: 'utf8',
          env: {
            ...process.env,
            IMAGE: 'ghcr.io/example/p/api',
            VERSION: '2.0.3',
            TAGS: options.tags,
            DIGEST_DIR: digestDir,
            EXPECTED_DIGESTS: '2',
            DOCKER_LOG: dockerLog,
            GITHUB_OUTPUT: githubOutput,
            STUB_INSPECT_JSON: JSON.stringify(
              options.inspectJson ?? { manifest: { digest: INDEX_DIGEST } }
            ),
          },
        })
        return {
          status: run.status ?? -1,
          output: `${run.stdout}${run.stderr}`,
          docker: readFileSync(dockerLog, 'utf8'),
          githubOutput: readFileSync(githubOutput, 'utf8'),
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })
})

/** The `run:` body of the step starting at `stepMarker`, de-indented from 10 spaces. */
function stepRunBody(stepMarker: string): string {
  const workflow = workflowText()
  const stepStart = workflow.indexOf(stepMarker)
  expect(stepStart, `${stepMarker} must exist in the workflow`).toBeGreaterThan(-1)

  const afterRun = workflow.slice(workflow.indexOf('run: |', stepStart) + 'run: |'.length)
  const bodyLines: string[] = []
  for (const line of afterRun.split('\n').slice(1)) {
    // The body is indented 10 spaces under `run: |`; the first line at a shallower indent ends it.
    if (line.trim() !== '' && !line.startsWith(' '.repeat(10))) break
    bodyLines.push(line.slice(10))
  }
  return bodyLines.join('\n')
}

/**
 * Extracts the `run:` body of the "Verify published image version matches the release tag" step
 * from the real workflow file and executes it with `docker buildx imagetools inspect` replaced by
 * a fixture, so the step's actual jq/bash logic is under test rather than its source text.
 */
function runVerifyStep(options: { imageName: string; version: string; inspectJson: unknown }): {
  status: number
  output: string
} {
  // The fixture reaches the script through an env var rather than a temp file, so nothing is
  // written to disk and nothing needs cleaning up.
  const script = stepRunBody(
    '- name: Verify published image version matches the release tag'
  ).replace(
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
