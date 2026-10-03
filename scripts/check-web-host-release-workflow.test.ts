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
const WORKFLOW_PATH = '.github/workflows/web-host-release.yml'
const PUBLISH_STEP = 'publish step'
const WORKFLOW = readFileSync(
  join(repositoryRoot, '.github', 'workflows', 'web-host-release.yml'),
  'utf8'
)
const RELEASE_TAG_RE = String.raw`^v((0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?)$`

interface Step {
  name?: string
  if?: string
  run?: string
  uses?: string
  env?: Record<string, string>
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

function triggerProblems(workflow: Workflow, text: string): string[] {
  return [
    ...(workflow.on?.push?.tags?.includes('v*') ? [] : ['does not run on v* tag pushes']),
    ...(text.includes(RELEASE_TAG_RE)
      ? []
      : ['validate does not use the full vMAJOR.MINOR.PATCH(-pre) regex']),
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
  return [
    ...jobIdentityProblems(job, options.name),
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

/** Story 68.3: the kit publishes first, and web-host never uploads without waiting for it. */
function kitOrderProblems(workflow: Workflow): string[] {
  const needs = workflow.jobs?.publish?.needs
  const list = typeof needs === 'string' ? [needs] : (needs ?? [])
  return list.includes('publish-kit')
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
    ...publishJobProblems(workflow.jobs?.['publish-kit'], {
      name: 'publish-kit',
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

function mutate(from: string, to: string): string {
  expect(WORKFLOW, `the workflow contains ${JSON.stringify(from)}`).toContain(from)
  return WORKFLOW.replace(from, to)
}

describe('web-host release workflow: this repo (Story 68.2 AC-10)', () => {
  it('meets the whole release contract', () => {
    expect(releaseWorkflowProblems(WORKFLOW)).toEqual([])
  })

  it('is wired into ci.yml and make ci-inner', () => {
    const command = 'pnpm vitest run scripts/check-web-host-release-workflow.test.ts'
    const ci = readFileSync(join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8')
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
    ['tag trigger', "      - 'v*'", "      - 'release-*'", /v\* tag pushes/],
    ['tag regex', '(-[0-9A-Za-z.-]+)?)$ ]]', '.*)$ ]]', /full vMAJOR/],
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
