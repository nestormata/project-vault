import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findPinViolations } from './lib/action-pins.js'
import { EXTENSION_API_REGISTRY_ONLY_ENV } from './lib/web-host/extension-api-source.js'
import { makeRecipe, recipeRunsCommand, workflowRunCommands } from './lib/ci-wiring.js'
import { parseYaml } from './lib/yaml.js'

// Story 68.2 AC-10: the contract of .github/workflows/web-host-release.yml. A release workflow
// cannot run on a PR, so this guard is what keeps a refactor from quietly publishing with a token,
// to `latest`, from both Node legs, or before the gates. Each rule has a self-test that mutates a
// copy of the real workflow and expects that rule, and only that rule, to fail.

const repositoryRoot = join(import.meta.dirname, '..')
const WORKFLOWS_DIR = join(repositoryRoot, '.github', 'workflows')
const WORKFLOW_FILE = 'web-host-release.yml'
const WORKFLOW_PATH = `.github/workflows/${WORKFLOW_FILE}`
const PUBLISH_STEP = 'publish step'
const KIT_JOB = 'publish-kit'
const VAULT_ACTION_TAG = 'vault-action-v1'
const WORKFLOW = readFileSync(join(WORKFLOWS_DIR, WORKFLOW_FILE), 'utf8')
const DOC = readFileSync(join(repositoryRoot, 'docs', 'releasing.md'), 'utf8')
// Story 68.12 (G6, D2): full releases only, exactly container-publish.yml's and cli-release.yml's regex.
const RELEASE_TAG_RE = String.raw`^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`
// Story 68.12 (G5): the trigger matches the npm-publish environment policy and the tag ruleset.
const TRIGGER_TAG = 'v[0-9]*'
// Story 68.12 AC-4 (D1): the Release and container-publish gate, and the tag-moved check.
const RELEASE_GATE = 'gh release view "$GITHUB_REF_NAME"'
const TAG_MOVED_CHECK = 'git ls-remote origin "refs/tags/$GITHUB_REF_NAME^{}"'
const ATTESTED_REF = '${{ github.sha }}'

interface Step {
  id?: string
  name?: string
  if?: string
  run?: string
  uses?: string
  env?: Record<string, string>
  with?: Record<string, unknown>
}

interface Job {
  needs?: string | string[]
  environment?: string
  permissions?: Record<string, string>
  steps?: Step[]
}

interface Workflow {
  on?: { push?: { tags?: string[] }; workflow_dispatch?: { inputs?: Record<string, unknown> } }
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean }
  jobs?: Record<string, Job>
}

const FIXTURE_TEST_GATE = 'scripts/check-web-host-consumer-fixture.test.ts'
const GATES = [
  RELEASE_GATE,
  'scripts/check-paraglide-plugin-pinned.test.ts',
  FIXTURE_TEST_GATE,
  'scripts/check-web-host-tarball.test.ts',
  'scripts/check-release-version-triangle.ts web-host',
  'npm view "@project-vault/web-host@',
  // Story 68.3: the kit named by the compatibility manifest must be on npm before web-host uploads.
  'npm view "@project-vault/composition-kit@',
]
// Story 68.3: what publish-kit must pass before it uploads the composition kit.
const KIT_GATES = [
  RELEASE_GATE,
  'pnpm check-composition-kit-boundary',
  'pnpm --filter @project-vault/composition-kit test',
  'scripts/check-release-version-triangle.ts composition-kit',
  'npm view "@project-vault/composition-kit@',
]

function stepIndex(steps: Step[], needle: string): number {
  return steps.findIndex((step) => step.run?.includes(needle))
}

function publishSteps(steps: Step[]): Step[] {
  return steps.filter((step) => step.run?.includes('npm publish'))
}

/** Story 68.12 (G5): exactly the pattern of the npm-publish policy and the tag ruleset. */
function tagTriggerProblems(tags: string[]): string[] {
  return tags.length === 1 && tags[0] === TRIGGER_TAG
    ? []
    : [
        `tag trigger is ${JSON.stringify(tags)}, not ['${TRIGGER_TAG}'] (G5: it must match the npm-publish policy and the tag ruleset; v* also fires on ${VAULT_ACTION_TAG})`,
      ]
}

function triggerProblems(workflow: Workflow, text: string): string[] {
  return [
    ...tagTriggerProblems(workflow.on?.push?.tags ?? []),
    ...(text.includes(RELEASE_TAG_RE)
      ? []
      : ['validate does not use the full-release-only vMAJOR.MINOR.PATCH regex (G6)']),
    ...(workflow.on?.workflow_dispatch?.inputs?.dry_run === undefined
      ? ['has no workflow_dispatch dry_run input']
      : []),
  ]
}

function concurrencyProblems(workflow: Workflow): string[] {
  const group = workflow.concurrency?.group ?? ''
  const groups = [...group.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '')
  const dryRunGroup = groups.find((name) => name.includes('dry-run'))
  const realGroup = groups.find((name) => !name.includes('dry-run'))
  const separate =
    group.includes('inputs.dry_run == true') &&
    dryRunGroup !== undefined &&
    realGroup !== undefined &&
    dryRunGroup !== realGroup
  return [
    ...(separate ? [] : ['a dry run does not get its own concurrency group']),
    ...(workflow.concurrency?.['cancel-in-progress'] === false
      ? []
      : ['a release run can be cancelled']),
  ]
}

/** The release's consumer fixture must build against the published extension-api, never fall back
 * to a workspace tarball (Nestor 2026-10-02: the fallback is for PR and local runs only). */
function fixtureRegistryOnlyProblems(steps: Step[]): string[] {
  const fixture = steps.find((step) => step.run?.includes(FIXTURE_TEST_GATE))
  return fixture?.env?.WEB_HOST_FIXTURE_REGISTRY_ONLY === '1'
    ? []
    : [`the consumer fixture step does not set ${EXTENSION_API_REGISTRY_ONLY_ENV}: '1'`]
}

function jobIdentityProblems(job: Job, name: string): string[] {
  return [
    ...(job.environment === 'npm-publish'
      ? []
      : [`${name} job is not in the npm-publish environment`]),
    ...(job.permissions?.['id-token'] === 'write'
      ? []
      : [`${name} job lacks id-token: write (OIDC)`]),
    ...(job.permissions?.contents === 'read'
      ? []
      : [`${name} job contents permission is not read`]),
    ...(job.permissions?.actions === 'read'
      ? []
      : [`${name} job lacks actions: read (the release gate reads container-publish runs)`]),
    ...Object.entries(job.permissions ?? {})
      .filter(([scope, level]) => level === 'write' && scope !== 'id-token')
      .map(([scope]) => `${name} job has ${scope}: write (only id-token may write)`),
  ]
}

/** Story 68.12 AC-4: build exactly the commit the provenance attests, never the tag re-resolved
 * after a long approval wait. */
function checkoutProblems(steps: Step[], name: string): string[] {
  const checkouts = steps.filter((step) => step.uses?.startsWith('actions/checkout@'))
  return checkouts.length > 0 && checkouts.every((step) => step.with?.ref === ATTESTED_REF)
    ? []
    : [`${name}: actions/checkout does not use ref ${ATTESTED_REF} (the attested commit)`]
}

/** Story 68.12 AC-4: the Release gate is report-only on a dry run, and the tag-moved check runs
 * before the real upload. */
function releaseGateProblems(steps: Step[], realUpload: number, name: string): string[] {
  const gate = steps.find((step) => step.run?.includes(RELEASE_GATE))
  const tagMoved = stepIndex(steps, TAG_MOVED_CHECK)
  return [
    ...((gate?.env?.REPORT_ONLY ?? '').includes('inputs.dry_run == true')
      ? []
      : [`${name}: the release gate is not report-only on a dry run`]),
    ...(tagMoved !== -1 && tagMoved < realUpload
      ? []
      : [`${name}: the "Fail if the tag moved" check is missing or runs after the real upload`]),
  ]
}

function publishJobProblems(
  job: Job | undefined,
  options: { name: string; gates: string[]; registryOnlyFixture: boolean }
): string[] {
  if (job === undefined) return [`has no ${options.name} job`]
  const steps = job.steps ?? []
  const uploads = publishSteps(steps)
  const real = uploads.filter((step) => !(step.run ?? '').includes('--dry-run'))
  const firstUpload = steps.findIndex((step) => uploads.includes(step))
  const realUpload = steps.findIndex((step) => real.includes(step))
  return [
    ...jobIdentityProblems(job, options.name),
    ...checkoutProblems(steps, options.name),
    ...releaseGateProblems(steps, realUpload, options.name),
    ...(real.length === 1
      ? []
      : [`${options.name}: expected exactly one real npm publish step, found ${real.length}`]),
    ...uploads.flatMap((step) => publishStepProblems(step)),
    ...(options.registryOnlyFixture ? fixtureRegistryOnlyProblems(steps) : []),
    ...(real.every((step) => (step.if ?? '').includes('inputs.dry_run != true'))
      ? []
      : ['the real publish runs on a dry run']),
    ...options.gates
      .filter((gate) => {
        const index = stepIndex(steps, gate)
        return index === -1 || index > firstUpload
      })
      .map((gate) => `${options.name}: gate "${gate}" is missing or runs after the upload`),
  ]
}

/** A job by its id, without indexing an object by a runtime string. */
function jobNamed(workflow: Workflow, id: string): Job | undefined {
  return new Map(Object.entries(workflow.jobs ?? {})).get(id)
}

/** Story 68.3: the kit publishes first, and web-host never uploads without waiting for it. */
function kitOrderProblems(workflow: Workflow): string[] {
  const needs = workflow.jobs?.publish?.needs
  const list = typeof needs === 'string' ? [needs] : (needs ?? [])
  return list.includes(KIT_JOB)
    ? []
    : ['publish does not need publish-kit (the kit must publish first)']
}

/** The `npm publish` command lines of a run script (not messages that merely mention it). */
function publishCommands(run: string): string[] {
  return run
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('npm publish ') || line.startsWith('if ! npm publish '))
}

/** The workflow without its comment lines: rules about tokens and commands apply to code only. */
function withoutComments(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
}

function publishStepProblems(step: Step): string[] {
  const run = step.run ?? ''
  return [
    ...['--provenance', '--access public', '--tag next']
      .filter((flag) => !run.includes(flag))
      .map((flag) => `${step.name ?? PUBLISH_STEP} lacks ${flag}`),
    ...(publishCommands(run).some((line) => line.includes('--force'))
      ? [`${step.name ?? PUBLISH_STEP} uses --force`]
      : []),
    ...((step.if ?? '').includes('matrix.node-version == 24')
      ? []
      : [`${step.name ?? PUBLISH_STEP} is not limited to the Node 24 leg`]),
  ]
}

/** Every contract violation of a web-host release workflow text. */
export function releaseWorkflowProblems(text: string): string[] {
  const workflow = parseYaml(text) as Workflow
  const code = withoutComments(text)
  const pins = findPinViolations({ [WORKFLOW_PATH]: text }).map(
    (violation) => `${violation.ref}: ${violation.reason}`
  )
  return [
    ...triggerProblems(workflow, text),
    ...concurrencyProblems(workflow),
    ...publishJobProblems(workflow.jobs?.publish, {
      name: 'publish',
      gates: GATES,
      registryOnlyFixture: true,
    }),
    ...publishJobProblems(jobNamed(workflow, KIT_JOB), {
      name: KIT_JOB,
      gates: KIT_GATES,
      registryOnlyFixture: false,
    }),
    ...kitOrderProblems(workflow),
    ...(/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\.NPM/.test(code)
      ? ['references an npm token secret']
      : []),
    ...(/^\s*npm unpublish\b/m.test(code) ? ['runs npm unpublish'] : []),
    ...pins,
  ]
}

/** Story 68.12 AC-1: the release doc must not contradict what a tag push does. Three assertions
 * only: it names the workflow before § 1, it names the workflow's real trigger pattern, and it
 * never says a tag push "triggers nothing" (the false sentence that shipped unnoticed in 68.2). */
export function releaseDocProblems(doc: string, workflowText: string): string[] {
  const workflow = parseYaml(workflowText) as Workflow
  const intro = doc.split(/^## 1\./m)[0] ?? ''
  return [
    ...(intro.includes(WORKFLOW_FILE)
      ? []
      : ['docs/releasing.md does not name web-host-release.yml before § 1']),
    ...(workflow.on?.push?.tags ?? [])
      .filter((pattern) => !doc.includes(pattern))
      .map((pattern) => `docs/releasing.md does not name the workflow's tag trigger ${pattern}`),
    ...(doc.includes('triggers nothing')
      ? ['docs/releasing.md says a tag push "triggers nothing"']
      : []),
  ]
}

function mutate(from: string, to: string): string {
  expect(WORKFLOW, `the workflow contains ${JSON.stringify(from)}`).toContain(from)
  return WORKFLOW.replace(from, to)
}

describe('web-host release workflow: this repo (Story 68.2 AC-10)', () => {
  it('meets the whole release contract', () => {
    expect(releaseWorkflowProblems(WORKFLOW)).toEqual([])
  })

  it('is described truthfully by docs/releasing.md (Story 68.12 AC-1)', () => {
    expect(releaseDocProblems(DOC, WORKFLOW)).toEqual([])
  })

  it('is wired into ci.yml and make ci-inner', () => {
    const command = 'pnpm vitest run scripts/check-web-host-release-workflow.test.ts'
    const ci = readFileSync(join(WORKFLOWS_DIR, 'ci.yml'), 'utf8')
    const makefile = readFileSync(join(repositoryRoot, 'Makefile'), 'utf8')
    expect(workflowRunCommands(ci)).toContain(command)
    expect(recipeRunsCommand(makeRecipe(makefile, 'ci-inner'), command)).toBe(true)
  })
})

const SKIPPED_RUN = 'run: echo skipped'
const REAL_PUBLISH = 'npm publish --provenance --access public --tag next;'
// The workflow's own SHA-pinned pnpm/action-setup line, read from it rather than repeated here.
const PNPM_SETUP_PIN =
  /pnpm\/action-setup@[0-9a-f]{40} # v[\d.]+/.exec(WORKFLOW)?.[0] ?? 'missing pin'

describe('web-host release workflow: each rule fails on a mutated copy (Story 68.2 AC-10)', () => {
  const cases: [string, string, string, RegExp][] = [
    ['tag trigger', `      - '${TRIGGER_TAG}'`, "      - 'v*'", /tag trigger is .*G5/],
    [
      'tag regex',
      String.raw`\.(0|[1-9][0-9]*)$ ]]`,
      String.raw`\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]]`,
      /full-release-only/,
    ],
    ['environment', 'environment: npm-publish', 'environment: other', /npm-publish environment/],
    ['OIDC', 'id-token: write', 'id-token: none', /id-token: write/],
    ['provenance', REAL_PUBLISH, 'npm publish --access public --tag next;', /lacks --provenance/],
    [
      'dist-tag',
      REAL_PUBLISH,
      'npm publish --provenance --access public --tag latest;',
      /lacks --tag next/,
    ],
    [
      'Node 24 only',
      'if: inputs.dry_run != true && matrix.node-version == 24',
      'if: inputs.dry_run != true',
      /not limited to the Node 24 leg/,
    ],
    [
      'dry run guard',
      'if: inputs.dry_run != true && matrix.node-version == 24',
      'if: matrix.node-version == 24',
      /real publish runs on a dry run/,
    ],
    [
      'token',
      '    env:\n      RELEASE_VERSION:',
      '    env:\n      NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n      RELEASE_VERSION:',
      /npm token secret/,
    ],
    [
      'concurrency',
      "format('web-host-release-dry-run-{0}', github.ref)",
      "'web-host-release'",
      /own concurrency group/,
    ],
    [
      'gate order',
      'run: pnpm exec tsx scripts/check-release-version-triangle.ts web-host',
      SKIPPED_RUN,
      /check-release-version-triangle\.ts web-host" is missing/,
    ],
    [
      'no force',
      REAL_PUBLISH,
      'npm publish --force --provenance --access public --tag next;',
      /uses --force/,
    ],
    [
      'registry-only fixture',
      `          ${EXTENSION_API_REGISTRY_ONLY_ENV}: '1'\n`,
      '',
      /does not set WEB_HOST_FIXTURE_REGISTRY_ONLY/,
    ],
    [
      'kit publishes first',
      'needs: [validate, publish-kit]',
      'needs: validate',
      /publish does not need publish-kit/,
    ],
    [
      'kit version triangle',
      'run: pnpm exec tsx scripts/check-release-version-triangle.ts composition-kit',
      SKIPPED_RUN,
      /check-release-version-triangle\.ts composition-kit" is missing/,
    ],
    [
      'kit boundary',
      'run: pnpm check-composition-kit-boundary',
      SKIPPED_RUN,
      /pnpm check-composition-kit-boundary" is missing/,
    ],
    [
      'kit on npm before web-host',
      'npm view "@project-vault/composition-kit@${KIT_VERSION}" version\n\n      - name: Reject',
      'echo skipped\n\n      - name: Reject',
      /publish: gate "npm view "@project-vault\/composition-kit@" is missing/,
    ],
    ['action pin', PNPM_SETUP_PIN, 'pnpm/action-setup@v6', /not a full 40-hex commit SHA/],
    // Story 68.12 AC-4.
    [
      'kit checkout ref',
      `      - uses: actions/checkout@v7\n        with:\n          ref: ${ATTESTED_REF}`,
      '      - uses: actions/checkout@v7\n        with:\n          ref: ${{ github.ref }}',
      /publish-kit: actions\/checkout does not use ref/,
    ],
    [
      'tag moved before the upload',
      `${TAG_MOVED_CHECK} | cut -f1`,
      'true | cut -f1',
      /publish-kit: the "Fail if the tag moved" check is missing/,
    ],
    [
      'release gate removed',
      `if ! RELEASE_JSON="$(${RELEASE_GATE}`,
      'if ! RELEASE_JSON="$(true',
      /publish-kit: gate "gh release view/,
    ],
    [
      'release gate report-only on a dry run',
      "REPORT_ONLY: ${{ inputs.dry_run == true && '1' || '0' }}",
      "REPORT_ONLY: '1'",
      /publish-kit: the release gate is not report-only/,
    ],
    ['actions read', 'actions: read', 'actions: write', /has actions: write/],
  ]

  for (const [rule, from, to, expected] of cases) {
    it(`rejects a workflow that breaks the ${rule} rule`, () => {
      const problems = releaseWorkflowProblems(mutate(from, to))
      expect(
        problems.some((problem) => expected.test(problem)),
        problems.join('\n')
      ).toBe(true)
    })
  }
})

describe('web-host release workflow: moving the release gate after the upload fails (Story 68.12 AC-4)', () => {
  it('rejects a publish job whose release gate runs after the upload', () => {
    const gateStart = WORKFLOW.lastIndexOf(
      '      - name: Require the published GitHub Release and a green container-publish for this tag'
    )
    const gateEnd = WORKFLOW.indexOf('\n      - ', gateStart + 1)
    expect(gateStart, 'the publish job has the release gate step').toBeGreaterThan(-1)
    const gateStep = WORKFLOW.slice(gateStart, gateEnd + 1)
    // publish is the last job, so appending puts the gate after its upload steps.
    const moved = `${WORKFLOW.slice(0, gateStart)}${WORKFLOW.slice(gateEnd + 1)}\n${gateStep}`
    const problems = releaseWorkflowProblems(moved)
    expect(problems, problems.join('\n')).toEqual([
      'publish: gate "gh release view "$GITHUB_REF_NAME"" is missing or runs after the upload',
    ])
  })
})

describe('docs/releasing.md: each doc rule fails on a mutated copy (Story 68.12 AC-1)', () => {
  it('rejects a doc whose intro does not name web-host-release.yml', () => {
    const [intro = '', ...rest] = DOC.split(/^(?=## 1\.)/m)
    const mutated = [intro.replaceAll(WORKFLOW_FILE, 'some-release.yml'), ...rest].join('')
    expect(releaseDocProblems(mutated, WORKFLOW)).toEqual([
      'docs/releasing.md does not name web-host-release.yml before § 1',
    ])
  })

  it("rejects a doc that does not name the workflow's real trigger pattern", () => {
    const workflow = mutate(`      - '${TRIGGER_TAG}'`, "      - 'release-[0-9]*'")
    expect(releaseDocProblems(DOC, workflow)).toEqual([
      "docs/releasing.md does not name the workflow's tag trigger release-[0-9]*",
    ])
  })

  it('rejects a doc that says a tag push triggers nothing', () => {
    expect(releaseDocProblems(`${DOC}\nPushing a tag triggers nothing.\n`, WORKFLOW)).toEqual([
      'docs/releasing.md says a tag push "triggers nothing"',
    ])
  })
})

interface Jobs {
  validate: { steps: Step[] }
  publish: { steps: Step[] }
  'publish-kit': { steps: Step[] }
}

const JOBS = (parseYaml(WORKFLOW) as { jobs: Jobs }).jobs

function runOf(steps: Step[], needle: (step: Step) => boolean): string {
  const run = steps.find(needle)?.run
  expect(run, 'the step exists and has a run script').toBeTypeOf('string')
  return run ?? ''
}

/** GitHub's filter-pattern semantics for the two features the trigger uses: `*` (any characters
 * except `/`) and a `[a-b]` character range. */
function matchesFilterPattern(pattern: string, name: string): boolean {
  if (pattern === '') return name === ''
  if (pattern.startsWith('*')) {
    const rest = pattern.slice(1)
    return Array.from({ length: name.length + 1 }, (_, index) => index).some(
      (index) =>
        !name.slice(0, index).includes('/') && matchesFilterPattern(rest, name.slice(index))
    )
  }
  const first = name.charAt(0)
  if (pattern.startsWith('[')) {
    const inRange = first !== '' && first >= pattern.charAt(1) && first <= pattern.charAt(3)
    return inRange && matchesFilterPattern(pattern.slice(pattern.indexOf(']') + 1), name.slice(1))
  }
  return first === pattern.charAt(0) && matchesFilterPattern(pattern.slice(1), name.slice(1))
}

// Runs a step script with GITHUB_OUTPUT set to a bash-made temp file (removed on exit), then
// prints that file, so the test itself writes no files.
const WITH_GITHUB_OUTPUT = `out="$(mktemp)"
trap 'rm -f "$out"' EXIT
GITHUB_OUTPUT="$out" bash -c "$STEP_SCRIPT" >&2 || exit $?
cat "$out"`

/** Runs the tagcheck step's script and returns what it wrote to GITHUB_OUTPUT. */
function runTagcheck(refType: string, refName: string): Record<string, string> {
  const run = spawnSync('bash', ['-c', WITH_GITHUB_OUTPUT], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      GITHUB_REF_TYPE: refType,
      GITHUB_REF_NAME: refName,
      STEP_SCRIPT: runOf(JOBS.validate.steps, (step) => step.id === 'tagcheck'),
    },
  })
  expect(run.status, run.stderr).toBe(0)
  return Object.fromEntries(
    run.stdout
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
  )
}

describe('web-host release workflow: the tagcheck script by behaviour (Story 68.12 AC-3)', () => {
  const trigger = (parseYaml(WORKFLOW) as Workflow).on?.push?.tags ?? []
  const cases: [string, string, string, string][] = [
    ['tag', 'v1.4.0', 'true', '1.4.0'],
    ['tag', 'v10.0.12', 'true', '10.0.12'],
    // D2 (Nestor 2026-10-03): prerelease tags are refused, like container-publish and cli-release.
    ['tag', 'v1.4.0-rc.1', 'false', ''],
    ['tag', 'v01.4.0', 'false', ''],
    ['tag', 'v1.4', 'false', ''],
    ['tag', 'v1.4.0.1', 'false', ''],
    ['tag', 'v1.4.0+build', 'false', ''],
    ['tag', VAULT_ACTION_TAG, 'false', ''],
    ['tag', 'extension-api-v3.27.0', 'false', ''],
    ['branch', 'v1.4.0', 'false', ''],
  ]

  for (const [refType, refName, shouldRelease, version] of cases) {
    it(`${refType} ${refName} -> should_release=${shouldRelease}, version=${version || '(empty)'}`, () => {
      expect(runTagcheck(refType, refName)).toEqual({ should_release: shouldRelease, version })
    })
  }

  it('the trigger fires on release tags and never on vault-action or extension-api tags', () => {
    expect(trigger).toEqual([TRIGGER_TAG])
    expect(trigger.some((pattern) => matchesFilterPattern(pattern, 'v1.4.0'))).toBe(true)
    expect(trigger.some((pattern) => matchesFilterPattern(pattern, 'v10.0.12'))).toBe(true)
    for (const name of [VAULT_ACTION_TAG, 'extension-api-v3.27.0']) {
      expect(
        trigger.some((pattern) => matchesFilterPattern(pattern, name)),
        name
      ).toBe(false)
    }
    // The old `v*` trigger did fire on vault-action-v1 (G5).
    expect(matchesFilterPattern('v*', VAULT_ACTION_TAG)).toBe(true)
  })
})

const RELEASE_PUBLISHED = JSON.stringify({ isDraft: false, isPrerelease: false, tagName: 'v1.4.0' })
const RELEASE_DRAFT = JSON.stringify({ isDraft: true, isPrerelease: false, tagName: 'v1.4.0' })
const runsWith = (...conclusions: (string | null)[]): string =>
  JSON.stringify({
    total_count: conclusions.length,
    workflow_runs: conclusions.map((conclusion, index) => ({
      id: index + 1,
      event: 'release',
      status: conclusion === null ? 'in_progress' : 'completed',
      conclusion,
    })),
  })

// A stub `gh`, defined as a bash function (it takes precedence over any `gh` on PATH, so the test
// writes no files): `gh release …` answers with $STUB_RELEASE, `gh api …` with $STUB_RUNS; the
// words `notfound` and `error` make it fail the way the real CLI does.
const STUB_GH = `gh() {
  if [[ "$1" == "release" ]]; then answer="$STUB_RELEASE"; else answer="$STUB_RUNS"; fi
  case "$answer" in
    notfound) echo 'release not found' >&2; return 1 ;;
    error) echo 'HTTP 502: Bad Gateway (https://api.github.com/)' >&2; return 1 ;;
    *) printf '%s\\n' "$answer" ;;
  esac
}
`

function runReleaseGate(options: { release: string; runs: string; reportOnly?: boolean }): {
  status: number
  stdout: string
  stderr: string
} {
  const script = runOf(JOBS.publish.steps, (step) => step.run?.includes(RELEASE_GATE) === true)
  const run = spawnSync('bash', ['-c', `${STUB_GH}${script}`], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      GITHUB_REF_NAME: 'v1.4.0',
      GITHUB_REPOSITORY: 'nestormata/project-vault',
      GITHUB_SHA: 'a'.repeat(40),
      REPORT_ONLY: options.reportOnly === true ? '1' : '0',
      STUB_RELEASE: options.release,
      STUB_RUNS: options.runs,
    },
  })
  return { status: run.status ?? -1, stdout: run.stdout, stderr: run.stderr }
}

describe('web-host release workflow: the release gate by behaviour (Story 68.12 AC-4)', () => {
  it('is the same script in publish-kit and publish', () => {
    const gate = (step: Step): boolean => step.run?.includes(RELEASE_GATE) === true
    const kitSteps = jobNamed(parseYaml(WORKFLOW) as Workflow, KIT_JOB)?.steps ?? []
    expect(runOf(kitSteps, gate)).toBe(runOf(JOBS.publish.steps, gate))
  })

  it('passes with a published Release and a green container-publish run', () => {
    const result = runReleaseGate({
      release: RELEASE_PUBLISHED,
      runs: runsWith('failure', 'success'),
    })
    expect(result.status, result.stdout + result.stderr).toBe(0)
  })

  it('fails when the Release does not exist yet, consuming no version', () => {
    const result = runReleaseGate({ release: 'notfound', runs: runsWith('success') })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('Release: missing (expected before H3)')
    expect(result.stderr).toContain('no version was consumed')
  })

  it('fails when the Release is a draft', () => {
    const result = runReleaseGate({ release: RELEASE_DRAFT, runs: runsWith('success') })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('Release: draft')
  })

  it('fails when container-publish is still running or red', () => {
    for (const runs of [runsWith(null), runsWith('failure'), runsWith()]) {
      const result = runReleaseGate({ release: RELEASE_PUBLISHED, runs })
      expect(result.status, runs).toBe(1)
      expect(result.stdout).toContain('container-publish: missing')
    }
  })

  it('fails closed on a GitHub API error', () => {
    for (const [release, runs] of [
      ['error', runsWith('success')],
      [RELEASE_PUBLISHED, 'error'],
      [RELEASE_PUBLISHED, '<html>502</html>'],
    ] as const) {
      const result = runReleaseGate({ release, runs })
      expect(result.status, `${release} / ${runs}`).toBe(1)
      expect(result.stderr).toContain('GitHub API error; retry the failed jobs')
    }
  })

  it('only reports on a dry run, printing both missing conditions', () => {
    const result = runReleaseGate({ release: 'notfound', runs: runsWith(), reportOnly: true })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Release: missing (expected before H3)')
    expect(result.stdout).toContain('container-publish: missing')
  })
})
