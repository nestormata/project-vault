import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The repository root has no YAML dependency; reuse the `yaml` package apps/api already depends on.
const { parse: parseYaml } = createRequire(resolve(process.cwd(), 'apps/api/package.json'))(
  'yaml'
) as typeof import('yaml')

/**
 * Story 64.3 AC-1..AC-3, AC-5: container image scan coverage contract.
 *  - nightly.yml scans every shipped image, and one failing scan never skips (masks) another;
 *  - every image scan honours `.trivyignore`, so a justified, time-boxed suppression is respected
 *    by every gate, not just the filesystem scan;
 *  - ci.yml scans the amd64 size-check images on every run, blocking only when the PR changes an
 *    image input and advisory (warning annotation, green job) otherwise.
 * The release gate (AC-4) is asserted in check-container-publish-workflow.test.ts.
 */

type Step = {
  id?: string
  name?: string
  if?: unknown
  uses?: string
  run?: string
  with?: Record<string, unknown>
  env?: Record<string, unknown>
  'continue-on-error'?: unknown
}

type Job = {
  'timeout-minutes'?: unknown
  strategy?: { 'fail-fast'?: unknown; matrix?: { include?: Record<string, unknown>[] } }
  steps?: Step[]
}

type Workflow = { on?: Record<string, unknown>; jobs?: Record<string, Job> }

const TRIVYIGNORE = '.trivyignore'
const API_DOCKERFILE = 'apps/api/Dockerfile'
const WEB_DOCKERFILE = 'apps/web/Dockerfile'
const LOCKFILE = 'pnpm-lock.yaml'
const CI_WORKFLOW = 'ci.yml'
const NIGHTLY_WORKFLOW = 'nightly.yml'
const PUBLISH_WORKFLOW = 'container-publish.yml'
const PULL_REQUEST = 'pull_request'
const API_SIZE_CHECK = 'project-vault-api:size-check'
const WEB_SIZE_CHECK = 'project-vault-web:size-check'

// Story 64.3 AC-3: the files whose change can alter a shipped image's contents.
const IMAGE_INPUTS = [
  API_DOCKERFILE,
  WEB_DOCKERFILE,
  'Dockerfile.ci',
  '.dockerignore',
  'apps/api/docker-entrypoint.sh',
  LOCKFILE,
  TRIVYIGNORE,
]

// The workflows and Makefile under test, read at transform time by Vite (vitest's module graph) as
// raw text: the same lint-clean loading pattern as check-action-pins.test.ts (Story 64.2).
const WORKFLOW_TEXT: Record<string, string> = import.meta.glob(
  [
    '../.github/workflows/ci.yml',
    '../.github/workflows/nightly.yml',
    '../.github/workflows/container-publish.yml',
  ],
  { query: '?raw', import: 'default', eager: true }
)
// `[e]` makes this a glob: vite:import-glob rejects the bare, extension-less `../Makefile` literal
// ("Expected pattern to be a non-empty string"). It still matches exactly one file.
const MAKEFILE_TEXT: Record<string, string> = import.meta.glob('../Makefil[e]', {
  query: '?raw',
  import: 'default',
  eager: true,
})

function workflowText(file: string): string {
  const text = Object.entries(WORKFLOW_TEXT).find(
    ([path]) => path === `../.github/workflows/${file}`
  )?.[1]
  expect(text, `.github/workflows/${file} must be loadable`).toBeDefined()
  return text ?? ''
}

function loadWorkflow(file: string): Workflow {
  return parseYaml(workflowText(file)) as Workflow
}

function job(workflow: Workflow, name: string): Job {
  const found = Object.entries(workflow.jobs ?? {}).find(([key]) => key === name)?.[1]
  expect(found, `job '${name}' must exist`).toBeDefined()
  return found ?? {}
}

function isTrivyStep(step: Step): boolean {
  return typeof step.uses === 'string' && step.uses.startsWith('aquasecurity/trivy-action@')
}

function trivySteps(target: Job): Step[] {
  return (target.steps ?? []).filter(isTrivyStep)
}

function isImageScan(step: Step): boolean {
  return step.with?.['image-ref'] !== undefined || step.with?.['scan-type'] === 'image'
}

function ifText(step: Step): string {
  return typeof step.if === 'string' ? step.if : ''
}

/**
 * A later scan step in the same job masks nothing only if it still runs after an earlier scan
 * failed, i.e. its `if:` opts out of the implicit `success()` with `!cancelled()`/`always()`.
 */
function maskingViolations(target: Job): string[] {
  return trivySteps(target)
    .slice(1)
    .filter((step) => !/!\s*cancelled\(\)|always\(\)/.test(ifText(step)))
    .map(
      (step) => `'${step.name ?? step.with?.['image-ref']}' is skipped when an earlier scan fails`
    )
}

/** The nightly's settings, which every image-scan gate must share (AC-3, AC-4). */
function expectGateSettings(step: Step): void {
  const label = step.name ?? String(step.with?.['image-ref'])
  expect(step.with?.severity, `${label}: severity`).toBe('CRITICAL,HIGH')
  expect(step.with?.['ignore-unfixed'], `${label}: ignore-unfixed`).toBe(true)
  expect(step.with?.['vuln-type'], `${label}: vuln-type`).toBe('os,library')
  expect(step.with?.trivyignores, `${label}: trivyignores`).toBe(TRIVYIGNORE)
}

describe('Story 64.3 AC-2: every image scan honours .trivyignore', () => {
  for (const file of [NIGHTLY_WORKFLOW, CI_WORKFLOW, PUBLISH_WORKFLOW]) {
    it(`${file}: every trivy image scan passes trivyignores: .trivyignore`, () => {
      const imageScans = Object.values(loadWorkflow(file).jobs ?? {})
        .flatMap(trivySteps)
        .filter(isImageScan)

      expect(imageScans.length, `${file} must contain at least one image scan`).toBeGreaterThan(0)
      for (const step of imageScans) {
        expect(step.with?.trivyignores, `${step.name}: trivyignores`).toBe(TRIVYIGNORE)
      }
    })
  }
})

describe('Story 64.3 AC-1: nightly scans every image and reports all of them', () => {
  const nightly = loadWorkflow(NIGHTLY_WORKFLOW)
  const trivyImage = job(nightly, 'trivy-image')

  it('is manually dispatchable, so a scan fix can be re-proven without waiting a night', () => {
    expect(Object.keys(nightly.on ?? {})).toContain('workflow_dispatch')
  })

  it('fans out over api and web in a matrix that does not cancel siblings on failure', () => {
    expect(trivyImage.strategy?.['fail-fast']).toBe(false)
    const names = (trivyImage.strategy?.matrix?.include ?? []).map((entry) => entry.name).sort()
    expect(names).toEqual(['api', 'web'])
  })

  it('no scan step masks another within a leg', () => {
    expect(maskingViolations(trivyImage)).toEqual([])
  })

  it('scans the image named by the matrix leg with the blocking gate settings', () => {
    const scans = trivySteps(trivyImage)
    expect(scans.length).toBeGreaterThan(0)
    for (const step of scans) {
      expect(String(step.with?.['image-ref'])).toMatch(/\$\{\{\s*matrix\.name\s*\}\}/)
      expect(step.with?.['exit-code']).toBe('1')
      // continue-on-error would turn a real finding into a green job: worse than no scan.
      expect(step['continue-on-error']).toBe(undefined)
      expectGateSettings(step)
    }
  })

  it('builds every image at the runner target that actually ships (Story 9.10 trap)', () => {
    const builds = (trivyImage.steps ?? []).filter((step) => /docker build/.test(step.run ?? ''))
    expect(builds.length).toBeGreaterThan(0)
    for (const step of builds) expect(step.run).toMatch(/--target runner/)
  })

  it('bounds the job with timeout-minutes so a hung pull cannot burn the 6-hour default', () => {
    expect(typeof trivyImage['timeout-minutes']).toBe('number')
    expect(Number(trivyImage['timeout-minutes'])).toBeLessThanOrEqual(60)
  })
})

describe('Story 64.3 AC-3: PR-time image scan in ci.yml docker-build', () => {
  const dockerBuild = job(loadWorkflow(CI_WORKFLOW), 'docker-build')
  const steps = dockerBuild.steps ?? []
  const detect = steps.find((step) => step.id === 'image-inputs')

  it('checks out full history so the base branch merge-base is resolvable', () => {
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'))
    expect(checkout?.with?.['fetch-depth']).toBe(0)
  })

  it('has an image-input change-detection step covering every image input', () => {
    expect(detect, "a step with id 'image-inputs' must exist").toBeDefined()
    expect(detect?.run).toMatch(/git fetch[^\n]*origin "\$BASE_REF"/)
    expect(detect?.run).toMatch(/git diff --name-only "origin\/\$\{BASE_REF\}\.\.\.HEAD"/)
    expect(detect?.run).toMatch(/images_changed=/)
    for (const input of IMAGE_INPUTS) expect(detect?.run).toContain(input)
  })

  it('passes github.* contexts through env:, never interpolated into the run: script', () => {
    expect(detect?.run).not.toMatch(/\$\{\{/)
    expect(String(detect?.env?.BASE_REF)).toMatch(/github\.base_ref/)
    expect(String(detect?.env?.EVENT_NAME)).toMatch(/github\.event_name/)
  })

  it('scans both size-check images on the amd64 leg only, neither masking the other', () => {
    const scans = trivySteps(dockerBuild)
    const refs = scans.map((step) => step.with?.['image-ref']).sort()
    expect(refs).toEqual([API_SIZE_CHECK, WEB_SIZE_CHECK])
    for (const step of scans) {
      expect(ifText(step)).toMatch(/matrix\.arch == 'amd64'/)
      expect(ifText(step)).toMatch(/!\s*cancelled\(\)/)
    }
    expect(maskingViolations(dockerBuild)).toEqual([])
  })

  it('places every scan after both size-check images are loaded', () => {
    const loads = [API_SIZE_CHECK, WEB_SIZE_CHECK].map((tag) =>
      steps.findIndex((step) => step.with?.tags === tag)
    )
    for (const index of loads) expect(index).toBeGreaterThan(-1)
    const lastLoad = Math.max(...loads)
    for (const step of trivySteps(dockerBuild)) {
      expect(steps.indexOf(step)).toBeGreaterThan(lastLoad)
    }
  })

  it('blocks only when image inputs changed; otherwise it is advisory', () => {
    for (const step of trivySteps(dockerBuild)) {
      expect(step.with?.['exit-code']).toBe('1')
      expect(String(step['continue-on-error'])).toMatch(
        /steps\.image-inputs\.outputs\.images_changed\s*!=\s*'true'/
      )
      expect(step.id, 'each scan needs an id so its outcome can be annotated').toBeTruthy()
      expectGateSettings(step)
    }
  })

  it('emits a warning annotation for an advisory scan that found something', () => {
    for (const step of trivySteps(dockerBuild)) {
      const outcomeCheck = `steps.${step.id}.outcome == 'failure'`
      const annotate = steps.find(
        (candidate) =>
          (candidate.run ?? '').includes('::warning') && ifText(candidate).includes(outcomeCheck)
      )
      expect(annotate, `a ::warning:: step must fire on ${outcomeCheck}`).toBeDefined()
    }
  })

  describe('change-detection script behaviour', () => {
    it('reports images_changed=true for a PR that touches an image input', () => {
      for (const input of [WEB_DOCKERFILE, TRIVYIGNORE, LOCKFILE]) {
        expect(runDetect({ event: PULL_REQUEST, changed: [input] }), input).toBe('true')
      }
    })

    it('reports images_changed=false for a PR that touches no image input', () => {
      expect(
        runDetect({ event: PULL_REQUEST, changed: ['README.md', 'apps/api/src/Dockerfile.md'] })
      ).toBe('false')
    })

    it('reports images_changed=false on push (nightly is the gate on main)', () => {
      expect(runDetect({ event: 'push', changed: [API_DOCKERFILE] })).toBe('false')
    })
  })
})

describe('Story 64.3 AC-5 (G3): the image-scan guards run in CI and make ci', () => {
  const guards = [
    'scripts/check-image-scan-workflows.test.ts',
    'scripts/check-container-publish-workflow.test.ts',
  ]

  it('ci.yml runs both guard suites', () => {
    const ciText = workflowText(CI_WORKFLOW)
    for (const guard of guards) expect(ciText).toContain(`pnpm vitest run ${guard}`)
  })

  it("Makefile's ci-inner runs both guard suites", () => {
    const makefile = Object.values(MAKEFILE_TEXT)[0] ?? ''
    const ciInner = /\nci-inner:[\s\S]*?(?=\n\S)/.exec(makefile)?.[0] ?? ''
    for (const guard of guards) expect(ciInner).toContain(guard)
  })
})

// Builds a throwaway origin + clone whose `pr` branch changes $CHANGED_FILES relative to
// origin/main, runs the real step body ($DETECT_SCRIPT) there, then prints what it wrote to
// $GITHUB_OUTPUT. All filesystem work stays in bash, and the trap removes the fixture.
const DETECT_HARNESS = String.raw`
set -euo pipefail
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid
export GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
git init -q --bare -b main "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/work" 2>/dev/null
cd "$ROOT/work"
echo seed > seed.txt
git add seed.txt
git commit -q -m seed
git push -q origin HEAD:main
git checkout -q -b pr
while IFS= read -r FILE; do
  [[ -n "$FILE" ]] || continue
  mkdir -p "$(dirname "$FILE")"
  echo x > "$FILE"
  git add -- "$FILE"
done <<<"$CHANGED_FILES"
git commit -q --allow-empty -m 'pr change'
export GITHUB_OUTPUT="$ROOT/github_output"
: > "$GITHUB_OUTPUT"
bash -c "$DETECT_SCRIPT" >&2
cat "$GITHUB_OUTPUT"
`

/**
 * Executes the real "image-inputs" step body in a throwaway clone whose PR branch changes the
 * given files relative to `origin/main`, and returns the `images_changed` output it wrote.
 */
function runDetect(options: { event: string; changed: string[] }): string {
  const detect = job(loadWorkflow(CI_WORKFLOW), 'docker-build').steps?.find(
    (step) => step.id === 'image-inputs'
  )
  expect(detect?.run, 'image-inputs step must have a run body').toBeTruthy()

  const run = spawnSync('bash', ['-c', DETECT_HARNESS], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DETECT_SCRIPT: detect?.run ?? '',
      CHANGED_FILES: options.changed.join('\n'),
      EVENT_NAME: options.event,
      BASE_REF: 'main',
    },
  })
  expect(run.status, `${run.stdout}${run.stderr}`).toBe(0)

  const line = run.stdout.split('\n').find((entry) => entry.startsWith('images_changed='))
  return line?.slice('images_changed='.length) ?? ''
}
