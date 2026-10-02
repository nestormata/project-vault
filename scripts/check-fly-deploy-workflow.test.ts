import { describe, expect, it } from 'vitest'

// The workflows are loaded as raw text by Vite (Story 43.28: replaces non-literal fs reads).
const WORKFLOWS: Record<string, string> = import.meta.glob('../.github/workflows/fly-*.yml', {
  query: '?raw',
  import: 'default',
  eager: true,
})

const deployWorkflowPath = '../.github/workflows/fly-deploy.yml'
const bootstrapWorkflowPath = '../.github/workflows/fly-bootstrap.yml'
const resetWorkflowPath = '../.github/workflows/fly-reset.yml'
const unsealWorkflowPath = '../.github/workflows/fly-auto-unseal.yml'

function readWorkflow(path: string): string {
  const text = Object.entries(WORKFLOWS).find(([key]) => key === path)?.[1]
  expect(text, path).toBeTypeOf('string')
  return text ?? ''
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

// Story 43.28: a minimal line-based model of the workflows (the repo's workflow guards read YAML as
// text). A step starts at a `      - ` line (six-space indent, the jobs' step list) and runs to the
// next one; `name`, `uses`, `run` and its own `env:` names are read from its lines.
type WorkflowStep = { name: string; uses: string; run: string; envNames: string[]; text: string }

const STEP_FIELD = /^ {6}(?:- | {2})(name|uses|run): (.*)$/
const ENV_NAME = /^([A-Z][A-Z0-9_]*):/

/** Names declared in the `env:` block that starts at `indent` spaces, within `lines`. */
function envNamesAt(lines: string[], indent: number): string[] {
  const names: string[] = []
  const header = `${' '.repeat(indent)}env:`
  const itemIndent = ' '.repeat(indent + 2)
  let inside = false
  for (const line of lines) {
    if (line === header) {
      inside = true
    } else if (inside && line.startsWith(itemIndent)) {
      const name = ENV_NAME.exec(line.slice(itemIndent.length))?.[1]
      if (name) names.push(name)
    } else if (inside && line.trim() !== '' && !line.trimStart().startsWith('#')) {
      inside = false
    }
  }
  return names
}

function parseSteps(workflow: string): WorkflowStep[] {
  const blocks: string[][] = []
  for (const line of workflow.split('\n')) {
    if (line.startsWith('      - ')) blocks.push([line])
    else if (line.startsWith('        ') || line.trim() === '') blocks.at(-1)?.push(line)
  }
  return blocks.map((lines) => {
    const fields = new Map<string, string>()
    for (const line of lines) {
      const match = STEP_FIELD.exec(line)
      if (match?.[1] && !fields.has(match[1])) fields.set(match[1], (match[2] ?? '').trim())
    }
    return {
      name: fields.get('name') ?? '',
      uses: fields.get('uses') ?? '',
      run: fields.get('run') ?? '',
      envNames: envNamesAt(lines, 8),
      text: lines.join('\n'),
    }
  })
}

/** The lines of one top-level job (`  <job>:`) up to the next job. */
function jobLines(workflow: string, job: string): string[] {
  const lines = workflow.split('\n')
  const start = lines.indexOf(`  ${job}:`)
  expect(start, `job ${job}`).toBeGreaterThan(-1)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('  ') && !line.startsWith('   '))
  return end === -1 ? rest : rest.slice(0, end)
}

function stepIndex(steps: WorkflowStep[], predicate: (step: WorkflowStep) => boolean): number {
  const index = steps.findIndex(predicate)
  expect(index, 'step not found').toBeGreaterThan(-1)
  return index
}

const API_APP = 'project-vault-demo-api'
const WEB_URL = 'https://project-vault-demo-web.fly.dev'
const ENSURE_SCRIPT = './scripts/fly-ensure-started.sh'
const MIGRATE_RUN = './scripts/fly-migrate.sh'
const isDeploy = (config: string) => (step: WorkflowStep) =>
  step.run.startsWith(`flyctl deploy -c ${config} `)
const isRun = (command: string) => (step: WorkflowStep) => step.run === command
const isEnsure = (step: WorkflowStep) => step.run.startsWith(ENSURE_SCRIPT)
const CA_NAMES = ['FLY_INTERNAL_CA_CERT_B64', 'FLY_INTERNAL_CA_KEY_B64']
const MIGRATE_SECRETS = [
  'ADMIN_PG_PASSWORD',
  'VAULT_APP_PASSWORD',
  'VAULT_ADMIN_PASSWORD',
  ...CA_NAMES,
]

const FLY_WORKFLOWS = [
  ['fly-bootstrap.yml', bootstrapWorkflowPath, 'bootstrap'],
  ['fly-reset.yml', resetWorkflowPath, 'reset'],
  ['fly-deploy.yml', deployWorkflowPath, 'deploy'],
] as const

describe('Fly Demo Bootstrap order (Story 43.28 AC-2/AC-4)', () => {
  const steps = parseSteps(readWorkflow(bootstrapWorkflowPath))

  it('runs setup -> migrate -> deploy api -> ensure started -> deploy web -> first reset', () => {
    const order = [
      stepIndex(steps, isRun('./scripts/fly-setup.sh')),
      stepIndex(steps, isRun(MIGRATE_RUN)),
      stepIndex(steps, isDeploy('fly.api.toml')),
      stepIndex(steps, isEnsure),
      stepIndex(steps, isDeploy('fly.web.toml')),
      stepIndex(steps, isRun('./scripts/fly-reset.sh')),
    ]
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(new Set(order).size).toBe(order.length)
  })

  it('migrates with the three DB passwords and the CA scoped to that step', () => {
    const migrate = steps.at(stepIndex(steps, isRun(MIGRATE_RUN)))
    expect(migrate?.name).toBe('Run pending migrations')
    expect([...(migrate?.envNames ?? [])].sort()).toEqual([...MIGRATE_SECRETS].sort())
  })

  it('ensures only the api app is started, without a web URL (web is not deployed yet)', () => {
    const ensure = steps.filter(isEnsure)
    expect(ensure.map((s) => s.run)).toEqual([`${ENSURE_SCRIPT} ${API_APP}`])
    expect(ensure.at(0)?.name).toBe('Ensure api machines are started')
  })
})

describe('Fly Demo Deploy recovery checks (Story 43.28 AC-4)', () => {
  const steps = parseSteps(readWorkflow(deployWorkflowPath))

  it('ensures the api is started after Deploy api, and reachable via web after Deploy web', () => {
    const migrate = stepIndex(steps, isRun(MIGRATE_RUN))
    const deployApi = stepIndex(steps, isDeploy('fly.api.toml'))
    const deployWeb = stepIndex(steps, isDeploy('fly.web.toml'))
    expect(migrate).toBeLessThan(deployApi)
    expect(steps.at(deployApi + 1)?.run).toBe(`${ENSURE_SCRIPT} ${API_APP}`)
    expect(deployWeb).toBeGreaterThan(deployApi + 1)
    expect(steps.at(deployWeb + 1)?.run).toBe(`${ENSURE_SCRIPT} ${API_APP} ${WEB_URL}`)
  })

  it('gives the ensure-started steps only FLY_API_TOKEN', () => {
    const ensure = steps.filter(isEnsure)
    expect(ensure).toHaveLength(2)
    for (const step of ensure) expect(step.envNames).toEqual(['FLY_API_TOKEN'])
  })
})

describe('Fly workflows keep the internal CA off deploy and recovery steps (43.16/43.28)', () => {
  it.each(FLY_WORKFLOWS)('%s: no flyctl deploy or ensure-started step sees it', (_n, path, job) => {
    const workflow = readWorkflow(path)
    // never at job level either, where every step would inherit it
    const jobEnv = envNamesAt(jobLines(workflow, job), 4)
    for (const name of CA_NAMES) expect(jobEnv).not.toContain(name)
    for (const step of parseSteps(workflow)) {
      if (step.run.startsWith('flyctl deploy') || isEnsure(step)) {
        for (const name of CA_NAMES) expect(step.envNames, step.name).not.toContain(name)
      }
    }
  })
})

describe('Fly workflows share one deploy concurrency group (Story 43.28 AC-3)', () => {
  it.each(FLY_WORKFLOWS)(
    '%s: its job queues on fly-demo-deploy, never cancels',
    (_n, path, job) => {
      const lines = jobLines(readWorkflow(path), job)
      const at = lines.indexOf('    concurrency:')
      expect(at).toBeGreaterThan(-1)
      expect(lines.slice(at + 1, at + 3)).toEqual([
        '      group: fly-demo-deploy',
        '      cancel-in-progress: false',
      ])
    }
  )

  it('keeps auto-unseal in its own group', () => {
    // Unseal is read-mostly and must still run while a long deploy holds fly-demo-deploy.
    const unseal = readWorkflow(unsealWorkflowPath)
    expect(unseal).toMatch(/concurrency:/)
    expect(unseal).not.toMatch(/fly-demo-deploy/)
  })
})

describe('Fly workflows use the release checkout pnpm (Story 43.28 AC-5)', () => {
  it.each(FLY_WORKFLOWS)('%s: pnpm/action-setup reads the release packageManager', (_n, path) => {
    const workflow = readWorkflow(path)
    const steps = parseSteps(workflow)
    const pnpm = stepIndex(steps, (s) => s.uses.startsWith('pnpm/action-setup@'))
    expect(steps.at(pnpm)?.text).not.toMatch(/^\s+version:/m)
    expect(steps.at(pnpm)?.text).not.toMatch(/^\s+with:/m)
    const checkout = stepIndex(steps, (s) => s.uses.startsWith('actions/checkout@'))
    expect(steps.at(checkout)?.text).toMatch(
      /^\s+ref: \$\{\{ (inputs\.release_tag|needs\.prepare\.outputs\.ref) \}\}$/m
    )
    expect(checkout).toBeLessThan(pnpm)
    expect(workflow).not.toMatch(/PNPM_VERSION|COREPACK_/)
  })
})
