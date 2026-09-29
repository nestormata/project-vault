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
 *  - ci.yml scans the amd64 size-check images on every run; one gate step blocks only when the PR
 *    changes an image input and is advisory (warning annotation, green job) otherwise.
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
// Beyond AC-3's api+web: the published `migrate` image is built and scanned on PRs too, so a
// broken or vulnerable migrate stage surfaces before a release rather than at the release gate.
const MIGRATE_SIZE_CHECK = 'project-vault-migrate:size-check'
// Story 43.16 AC-13: the Fly demo's db image (deploy/fly/db) is built and scanned on PRs too. It is
// deployed by `flyctl deploy` from source, never published to GHCR, so it has no release gate.
const FLY_DB_SIZE_CHECK = 'project-vault-fly-db:size-check'
const FLY_DB_DOCKERFILE = 'deploy/fly/db/Dockerfile'
const SIZE_CHECK_IMAGES = [API_SIZE_CHECK, FLY_DB_SIZE_CHECK, MIGRATE_SIZE_CHECK, WEB_SIZE_CHECK]
const GATE_STEP = 'Enforce image scan gate'
const DOCKER_BUILD_JOB = 'docker-build'

// Story 64.3 AC-3: the files whose change can alter a shipped image's contents.
const IMAGE_INPUTS = [
  API_DOCKERFILE,
  WEB_DOCKERFILE,
  'Dockerfile.ci',
  '.dockerignore',
  'apps/api/docker-entrypoint.sh',
  LOCKFILE,
  'pnpm-workspace.yaml',
  'scripts/materialize-deploy-runtime.mjs',
  TRIVYIGNORE,
  'fly.db.toml',
]
// Story 43.16 AC-13: any file under this directory is a fly-db image input.
const IMAGE_INPUT_DIRS = ['deploy/fly/db/']

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

  it('fans out over every published image in a matrix that does not cancel siblings', () => {
    expect(trivyImage.strategy?.['fail-fast']).toBe(false)
    const names = (trivyImage.strategy?.matrix?.include ?? []).map((entry) => entry.name).sort()
    // migrate is published and release-gated too; nightly is its only blocking gate on main.
    // fly-db (Story 43.16 AC-13) is nightly + PR only: fly deploy builds it from source.
    expect(names).toEqual(['api', 'fly-db', 'migrate', 'web'])
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

  it('builds every image at the target that actually ships (Story 9.10 trap)', () => {
    const include = trivyImage.strategy?.matrix?.include ?? []
    const targets = Object.fromEntries(include.map((entry) => [entry.name, entry.target]))
    expect(targets).toEqual({
      api: 'runner',
      'fly-db': 'runner',
      migrate: 'migrate',
      web: 'runner',
    })
    const files = Object.fromEntries(include.map((entry) => [entry.name, entry.file]))
    expect(files['fly-db']).toBe(FLY_DB_DOCKERFILE)
    const builds = (trivyImage.steps ?? []).filter((step) => /docker build/.test(step.run ?? ''))
    expect(builds.length).toBeGreaterThan(0)
    for (const step of builds) {
      expect(step.run).toMatch(/--target "\$TARGET"/)
      expect(String(step.env?.TARGET)).toMatch(/\$\{\{\s*matrix\.target\s*\}\}/)
    }
  })

  it('bounds the job with timeout-minutes so a hung pull cannot burn the 6-hour default', () => {
    expect(typeof trivyImage['timeout-minutes']).toBe('number')
    expect(Number(trivyImage['timeout-minutes'])).toBeLessThanOrEqual(60)
  })
})

describe('Story 64.3 AC-3: PR-time image scan in ci.yml docker-build', () => {
  const dockerBuild = job(loadWorkflow(CI_WORKFLOW), DOCKER_BUILD_JOB)
  const steps = dockerBuild.steps ?? []
  const detect = steps.find((step) => step.id === 'image-inputs')

  it('checks out full history so the base branch merge-base is resolvable', () => {
    const checkout = steps.find((step) => step.uses?.startsWith('actions/checkout@'))
    expect(checkout?.with?.['fetch-depth']).toBe(0)
  })

  it('has an image-input change-detection step covering every image input', () => {
    expect(detect, "a step with id 'image-inputs' must exist").toBeDefined()
    expect(detect?.run).toMatch(/git fetch[^\n]*origin "\$BASE_REF"/)
    expect(detect?.run).toMatch(
      /git diff --name-only --no-renames "origin\/\$\{BASE_REF\}\.\.\.HEAD"/
    )
    expect(detect?.run).toMatch(/images_changed=/)
    for (const input of [...IMAGE_INPUTS, ...IMAGE_INPUT_DIRS]) expect(detect?.run).toContain(input)
  })

  it('passes github.* contexts through env:, never interpolated into the run: script', () => {
    expect(detect?.run).not.toMatch(/\$\{\{/)
    expect(String(detect?.env?.BASE_REF)).toMatch(/github\.base_ref/)
    expect(String(detect?.env?.EVENT_NAME)).toMatch(/github\.event_name/)
  })

  it('scans every size-check image on the amd64 leg only, none masking another', () => {
    const scans = trivySteps(dockerBuild)
    const refs = scans.map((step) => step.with?.['image-ref']).sort()
    expect(refs).toEqual(SIZE_CHECK_IMAGES)
    for (const step of scans) {
      expect(ifText(step)).toMatch(/matrix\.arch == 'amd64'/)
      expect(ifText(step)).toMatch(/!\s*cancelled\(\)/)
    }
    expect(maskingViolations(dockerBuild)).toEqual([])
  })

  it('places every scan after all size-check images are loaded', () => {
    const loads = SIZE_CHECK_IMAGES.map((tag) => steps.findIndex((step) => step.with?.tags === tag))
    for (const index of loads) expect(index).toBeGreaterThan(-1)
    const lastLoad = Math.max(...loads)
    for (const step of trivySteps(dockerBuild)) {
      expect(steps.indexOf(step)).toBeGreaterThan(lastLoad)
    }
  })

  it('builds the published migrate target on the amd64 leg, loaded for the scan', () => {
    const load = steps.find((step) => step.with?.tags === MIGRATE_SIZE_CHECK) ?? {}
    const inputs = load.with ?? {}
    expect(load.uses).toMatch(/^docker\/build-push-action@/)
    expect(inputs).toMatchObject({ file: API_DOCKERFILE, target: 'migrate', load: true })
    expect(ifText(load)).toMatch(/matrix\.arch == 'amd64'/)
    // Reuses the api build's buildx cache: migrate shares its builder/db-builder stages.
    expect(String(inputs['cache-from'])).toContain('scope=api-${{ matrix.arch }}')
  })

  it('builds the Fly db image (Story 43.16 AC-13) on the amd64 leg, loaded for the scan', () => {
    const load = steps.find((step) => step.with?.tags === FLY_DB_SIZE_CHECK) ?? {}
    expect(load.uses).toMatch(/^docker\/build-push-action@/)
    expect(load.with ?? {}).toMatchObject({ file: FLY_DB_DOCKERFILE, target: 'runner', load: true })
    expect(ifText(load)).toMatch(/matrix\.arch == 'amd64'/)
  })

  it('gates each scan on the outcome of the step that loaded its own image', () => {
    for (const scan of trivySteps(dockerBuild)) {
      const load = steps.find((step) => step.with?.tags === scan.with?.['image-ref'])
      expect(load?.id, `${String(scan.with?.['image-ref'])} load step needs an id`).toBeTruthy()
      expect(ifText(scan)).toContain(`steps.${load?.id}.outcome == 'success'`)
    }
  })

  it('lets every scan finish (continue-on-error: true) and records findings in its outcome', () => {
    for (const step of trivySteps(dockerBuild)) {
      expect(step.with?.['exit-code']).toBe('1')
      // Never a per-step `images_changed` expression here: on this composite action it let a real
      // finding through green with images_changed=true (throwaway PR #464). The gate step decides.
      expect(step['continue-on-error']).toBe(true)
      expect(step.id, 'each scan needs an id so the gate step can read its outcome').toBeTruthy()
      expectGateSettings(step)
    }
  })

  it('enforces the blocking/advisory policy in one gate step after every scan', () => {
    const gate = steps.find((step) => step.name === GATE_STEP) ?? {}
    expect(gate.run, `a '${GATE_STEP}' step with a run body must exist`).toBeTruthy()
    const lastScan = Math.max(...trivySteps(dockerBuild).map((step) => steps.indexOf(step)))
    expect(steps.indexOf(gate)).toBeGreaterThan(lastScan)
    expect(ifText(gate)).toMatch(/!\s*cancelled\(\)/)
    expect(ifText(gate)).toMatch(/matrix\.arch == 'amd64'/)
    expect(gate['continue-on-error']).toBe(undefined)
    expect(gate.run).not.toMatch(/\$\{\{/)
    const fed = Object.values(gate.env ?? {}).map(String)
    expect(fed).toContain('${{ steps.image-inputs.outputs.images_changed }}')
    for (const scan of trivySteps(dockerBuild)) {
      const outcome = `steps.${scan.id}.outcome`
      expect(
        fed.some((value) => value.includes(outcome)),
        `gate must read ${outcome}`
      ).toBe(true)
    }
  })

  describe('gate script behaviour', () => {
    it('fails and emits ::error when an image input changed and a scan found something', () => {
      const result = runGate({ changed: 'true', outcomes: { web: 'failure' } })
      expect(result.status).toBe(1)
      expect(result.stdout).toMatch(/::error title=Image scan \(web\)::/)
    })

    it('stays green with a ::warning when no image input changed (PR or push)', () => {
      for (const changed of ['false', '']) {
        const result = runGate({ changed, outcomes: { api: 'failure', web: 'failure' } })
        expect(result.status, `images_changed='${changed}'`).toBe(0)
        expect(result.stdout).toMatch(/::warning title=Advisory image scan \(api\)::/)
        expect(result.stdout).toMatch(/::warning title=Advisory image scan \(web\)::/)
        expect(result.stdout).not.toMatch(/::error/)
      }
    })

    it('blocks on a fly-db finding when an image input changed (Story 43.16 AC-13)', () => {
      const result = runGate({ changed: 'true', outcomes: { 'fly-db': 'failure' } })
      expect(result.status).toBe(1)
      expect(result.stdout).toMatch(/::error title=Image scan \(fly-db\)::/)
    })

    it('passes when every scan succeeded or was skipped', () => {
      const result = runGate({
        changed: 'true',
        outcomes: { api: 'success', migrate: 'skipped', web: 'success' },
      })
      expect(result.status).toBe(0)
      expect(result.stdout).not.toMatch(/::(error|warning)/)
    })
  })

  describe('change-detection script behaviour', () => {
    it('reports images_changed=true for a PR that touches an image input', () => {
      for (const input of [
        WEB_DOCKERFILE,
        TRIVYIGNORE,
        LOCKFILE,
        'fly.db.toml',
        'deploy/fly/db/pg_hba.conf',
        'deploy/fly/db/entrypoint-tls.sh',
      ]) {
        expect(runDetect({ event: PULL_REQUEST, changed: [input] }), input).toBe('true')
      }
    })

    it('reports images_changed=false for a PR that touches no image input', () => {
      expect(
        runDetect({
          event: PULL_REQUEST,
          changed: ['README.md', 'apps/api/src/Dockerfile.md', 'docs/deploy/fly/db/notes.md'],
        })
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
git init -q --bare -b main "$ROOT/origin.git"
git clone -q "$ROOT/origin.git" "$ROOT/work" 2>/dev/null
cd "$ROOT/work"
git config user.name t
git config user.email test@invalid
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
  const detect = job(loadWorkflow(CI_WORKFLOW), DOCKER_BUILD_JOB).steps?.find(
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

/**
 * Executes the real "Enforce image scan gate" step body with the given images_changed output and
 * scan outcomes (missing ones are '', as for a step that never ran), returning its exit status and
 * stdout.
 */
function runGate(options: {
  changed: string
  outcomes: Partial<Record<'api' | 'fly-db' | 'migrate' | 'web', string>>
}): { status: number | null; stdout: string } {
  const gate = job(loadWorkflow(CI_WORKFLOW), DOCKER_BUILD_JOB).steps?.find(
    (step) => step.name === GATE_STEP
  )
  expect(gate?.run, 'gate step must have a run body').toBeTruthy()

  const run = spawnSync('bash', ['-c', gate?.run ?? ''], {
    encoding: 'utf8',
    env: {
      ...process.env,
      IMAGES_CHANGED: options.changed,
      SCAN_API: options.outcomes.api ?? '',
      SCAN_FLY_DB: options.outcomes['fly-db'] ?? '',
      SCAN_MIGRATE: options.outcomes.migrate ?? '',
      SCAN_WEB: options.outcomes.web ?? '',
    },
  })
  return { status: run.status, stdout: run.stdout }
}
