import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The repository root has no YAML dependency; reuse the `yaml` package apps/api already depends on.
const { parse: parseYaml } = createRequire(resolve(process.cwd(), 'apps/api/package.json'))(
  'yaml'
) as typeof import('yaml')

/** Story 43.6 AC-5 — the `pvault` release workflow's contract. */
const workflowPath = resolve(process.cwd(), '.github/workflows/cli-release.yml')

function workflowText(): string {
  return readFileSync(workflowPath, 'utf8')
}

type Step = {
  id?: string
  name?: string
  if?: unknown
  uses?: string
  run?: string
  with?: Record<string, unknown>
  env?: Record<string, unknown>
}

type Job = { if?: unknown; steps?: Step[] }

type DispatchInput = {
  type?: unknown
  required?: unknown
  default?: unknown
  description?: unknown
}

type Workflow = {
  on?: Record<string, { types?: unknown; inputs?: Record<string, DispatchInput> } | null>
  concurrency?: { group?: unknown; 'cancel-in-progress'?: unknown }
  jobs?: Record<string, Job>
}

function parseWorkflow(text: string): Workflow {
  return parseYaml(text) as Workflow
}

/** Runs only for published releases or a manual dispatch that names the tag — nothing else. */
function triggerViolations(workflow: Workflow): string[] {
  const on = workflow.on ?? {}
  const violations: string[] = []
  const triggers = Object.keys(on).sort()
  if (triggers.join(',') !== 'release,workflow_dispatch') {
    violations.push(`unexpected triggers: ${triggers.join(', ')}`)
  }
  if (JSON.stringify(on.release?.types) !== JSON.stringify(['published'])) {
    violations.push('release must trigger on types [published] only')
  }
  if (on.workflow_dispatch?.inputs?.tag == null) {
    violations.push('workflow_dispatch must declare a tag input')
  }
  return violations
}

// ---------------------------------------------------------------------------------------------
// Story 43.10 AC-2: a minimal evaluator for the GitHub Actions expressions this workflow uses, so
// the contract is checked on what an expression EVALUATES to for each kind of run, not only on its
// text. It implements GitHub's documented semantics for the operators used here: `&&`/`||` return
// an operand (not a boolean), `!`, and loose `==`/`!=` (operands of different types are coerced to
// numbers: null -> 0, false -> 0, true -> 1; strings compare case-insensitively).
// ---------------------------------------------------------------------------------------------

type ExprValue = string | number | boolean | null | ExprObject
type ExprObject = { [key: string]: ExprValue | undefined }

/** The three kinds of run the workflow must tell apart, plus a dispatch that omits dry_run. */
type RunKind = 'release' | 'dispatch' | 'dispatch-dry-run' | 'dispatch-no-dry-run-input'

const RELEASE_RUN: RunKind = 'release'
const DRY_RUN: RunKind = 'dispatch-dry-run'
const REAL_RUNS: RunKind[] = [RELEASE_RUN, 'dispatch', 'dispatch-no-dry-run-input']
const ALL_RUNS: RunKind[] = [...REAL_RUNS, DRY_RUN]
const REAL_GROUP = 'cli-release'
const CANDIDATE_TAG = 'v1.3.0'

// Outside workflow_dispatch the `inputs` context is empty, so `inputs.dry_run` is null there.
const RUN_INPUTS: Record<RunKind, ExprObject> = {
  release: {},
  dispatch: { tag: CANDIDATE_TAG, dry_run: false },
  'dispatch-dry-run': { tag: CANDIDATE_TAG, dry_run: true },
  'dispatch-no-dry-run-input': { tag: CANDIDATE_TAG },
}

function eventNameFor(kind: RunKind): string {
  return kind === RELEASE_RUN ? 'release' : 'workflow_dispatch'
}

function contextFor(kind: RunKind): ExprObject {
  return { github: { event_name: eventNameFor(kind) }, inputs: RUN_INPUTS[kind] }
}

const TOKEN = /'(?:[^']|'')*'|&&|\|\||==|!=|!|\(|\)|\w[\w.-]*/y

function tokenize(source: string): string[] {
  const tokens: string[] = []
  let rest = source.trim()
  while (rest.length > 0) {
    TOKEN.lastIndex = 0
    const match = TOKEN.exec(rest)
    if (!match) throw new Error(`cannot tokenize expression near: ${rest}`)
    tokens.push(match[0])
    rest = rest.slice(match[0].length).trimStart()
  }
  return tokens
}

function truthy(value: ExprValue | undefined): boolean {
  return !(value === false || value === 0 || value === '' || value === null || value === undefined)
}

function toNumber(value: ExprValue): number {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'number') return value
  if (typeof value === 'string') return value.trim() === '' ? 0 : Number(value)
  return value === null ? 0 : Number.NaN
}

function looseEquals(left: ExprValue, right: ExprValue): boolean {
  if (typeof left === 'string' && typeof right === 'string') {
    return left.toLowerCase() === right.toLowerCase()
  }
  if (typeof left === typeof right && typeof left !== 'object') return left === right
  return toNumber(left) === toNumber(right)
}

function lookup(path: string, context: ExprObject): ExprValue {
  let current: ExprValue | undefined = context
  for (const part of path.split('.')) {
    current = current !== null && typeof current === 'object' ? current[part] : undefined
  }
  return current ?? null
}

function literal(token: string, context: ExprObject): ExprValue {
  if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'")
  if (/^\d+$/.test(token)) return Number(token)
  const keywords: Record<string, ExprValue> = { true: true, false: false, null: null }
  return Object.hasOwn(keywords, token) ? (keywords[token] ?? null) : lookup(token, context)
}

/** Recursive-descent evaluation of one expression: `||` < `&&` < `==`/`!=` < `!`/`( )`. */
class ExpressionEvaluator {
  private position = 0

  constructor(
    private readonly tokens: string[],
    private readonly context: ExprObject
  ) {}

  run(): ExprValue {
    const value = this.or()
    if (this.position !== this.tokens.length)
      throw new Error(`trailing tokens: ${this.tokens.join(' ')}`)
    return value
  }

  private next(): string {
    const token = this.tokens[this.position]
    if (token === undefined) throw new Error(`unexpected end: ${this.tokens.join(' ')}`)
    this.position += 1
    return token
  }

  private or(): ExprValue {
    let left = this.and()
    while (this.tokens[this.position] === '||') {
      this.position += 1
      const right = this.and()
      left = truthy(left) ? left : right
    }
    return left
  }

  private and(): ExprValue {
    let left = this.comparison()
    while (this.tokens[this.position] === '&&') {
      this.position += 1
      const right = this.comparison()
      left = truthy(left) ? right : left
    }
    return left
  }

  private comparison(): ExprValue {
    let left = this.unary()
    let operator = this.tokens[this.position]
    while (operator === '==' || operator === '!=') {
      this.position += 1
      const equal = looseEquals(left, this.unary())
      left = operator === '==' ? equal : !equal
      operator = this.tokens[this.position]
    }
    return left
  }

  private unary(): ExprValue {
    const token = this.next()
    if (token === '!') return !truthy(this.unary())
    if (token !== '(') return literal(token, this.context)
    const value = this.or()
    if (this.next() !== ')') throw new Error(`missing ) in ${this.tokens.join(' ')}`)
    return value
  }
}

function evaluateExpression(expression: string, context: ExprObject): ExprValue {
  return new ExpressionEvaluator(tokenize(expression), context).run()
}

const INTERPOLATION = /\$\{\{([^}]*)\}\}/g

/**
 * Evaluates a workflow value against a run context, as GitHub does: a bare `if:` condition is an
 * expression; any other field is a literal unless it contains `${{ }}`, and a field that is exactly
 * one `${{ }}` keeps the expression's type while a mixed field interpolates into a string.
 */
function evaluate(
  value: unknown,
  context: ExprObject,
  { condition = false }: { condition?: boolean } = {}
): ExprValue {
  if (typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value !== 'string') throw new Error(`not an expression: ${String(value)}`)
  const text = value.trim()
  const whole = /^\$\{\{([^}]*)\}\}$/.exec(text)
  if (whole) return evaluateExpression(whole[1], context)
  if (condition) return evaluateExpression(text, context)
  return text.replaceAll(INTERPOLATION, (_match, inner: string) =>
    String(evaluateExpression(inner, context) ?? '')
  )
}

/**
 * Real runs share one `cli-release` group; dry-runs get their own group, so a dry-run can never
 * cancel a PENDING real release (GitHub keeps one pending run per group and cancels the older one
 * even when in-progress runs are never cancelled). Never cancels an in-flight run.
 */
function concurrencyViolations(workflow: Workflow): string[] {
  const violations: string[] = []
  const group = workflow.concurrency?.group
  if (group === undefined) {
    violations.push('concurrency group is missing')
  } else {
    for (const kind of REAL_RUNS) {
      if (evaluate(group, contextFor(kind)) !== REAL_GROUP) {
        violations.push(`concurrency group must evaluate to ${REAL_GROUP} for a ${kind} run`)
      }
    }
    const dryGroup = evaluate(group, contextFor(DRY_RUN))
    if (typeof dryGroup !== 'string' || dryGroup === '' || dryGroup === REAL_GROUP) {
      violations.push('a dry-run must use its own, non-empty concurrency group')
    }
  }
  if (workflow.concurrency?.['cancel-in-progress'] !== false) {
    violations.push('cancel-in-progress must be false')
  }
  return violations
}

const DRY_RUN_GROUP_TEXT = "${{ inputs.dry_run == true && 'cli-release-dry-run' || 'cli-release' }}"
const PUBLISH_CONDITION = "github.event_name == 'release' || inputs.dry_run != true"
const SUMMARY_CONDITION = "steps.release.outputs.dry_run == 'true'"
const DRY_RUN_SUMMARY =
  'DRY RUN: nothing uploaded; bundle kept as artifact pvault-bundle (1 day); do not distribute'

function releaseSteps(workflow: Workflow): Step[] {
  return workflow.jobs?.release?.steps ?? []
}

function findStep(workflow: Workflow, predicate: (step: Step) => boolean): Step | undefined {
  return releaseSteps(workflow).find(predicate)
}

function dryRunInputViolations(workflow: Workflow): string[] {
  const input = workflow.on?.workflow_dispatch?.inputs?.dry_run
  const ok =
    input?.type === 'boolean' &&
    input.required === false &&
    input.default === false &&
    typeof input.description === 'string' &&
    input.description.includes('never uploads')
  return ok ? [] : ['dry_run must be an optional boolean input, default false, "never uploads"']
}

function publishGateViolations(workflow: Workflow): string[] {
  const jobs = workflow.jobs ?? {}
  const violations = ['release', 'verify']
    .filter((job) => jobs[job]?.if !== undefined)
    .map((job) => `${job} must run for every kind of run (no if:)`)
  const gate = jobs.publish?.if
  if (gate !== PUBLISH_CONDITION) {
    return [...violations, `publish must be gated by exactly: if: ${PUBLISH_CONDITION}`]
  }
  for (const kind of ALL_RUNS) {
    const runs = truthy(evaluate(gate, contextFor(kind), { condition: true }))
    if (runs !== (kind !== DRY_RUN)) violations.push(`publish gate is wrong for a ${kind} run`)
  }
  return violations
}

function envIndirectionViolations(workflow: Workflow): string[] {
  const violations: string[] = []
  const dryRunEnv = findStep(workflow, (step) => step.id === 'release')?.env?.DRY_RUN
  if (dryRunEnv === undefined) {
    violations.push('the validate step must receive dry_run through env: DRY_RUN')
  } else {
    for (const kind of ALL_RUNS) {
      if (evaluate(dryRunEnv, contextFor(kind)) !== (kind === DRY_RUN)) {
        violations.push(`DRY_RUN evaluates wrongly for a ${kind} run`)
      }
    }
  }
  const steps = Object.values(workflow.jobs ?? {}).flatMap((job) => job.steps ?? [])
  for (const step of steps.filter((candidate) => candidate.run?.includes('${{'))) {
    violations.push(`step "${step.name ?? step.id}" interpolates an expression inside run:`)
  }
  return violations
}

function usesAction(prefix: string): (step: Step) => boolean {
  return (step) => step.uses?.startsWith(prefix) === true
}

function checkoutRefViolations(workflow: Workflow): string[] {
  const checkout = findStep(workflow, usesAction('actions/checkout@'))
  return checkout?.with?.ref === '${{ steps.release.outputs.ref }}'
    ? []
    : ['the checkout ref must be the validate step output steps.release.outputs.ref']
}

function retentionViolations(workflow: Workflow): string[] {
  const retention = findStep(workflow, usesAction('actions/upload-artifact@'))?.with?.[
    'retention-days'
  ]
  const expected = (kind: RunKind): number => (kind === DRY_RUN ? 1 : 7)
  const ok =
    retention !== undefined &&
    ALL_RUNS.every((kind) => evaluate(retention, contextFor(kind)) === expected(kind))
  return ok ? [] : ['the bundle artifact must be kept 1 day for a dry-run and 7 days otherwise']
}

function summaryViolations(workflow: Workflow): string[] {
  const summary = findStep(workflow, (step) => step.run?.includes('GITHUB_STEP_SUMMARY') === true)
  const ok = summary?.if === SUMMARY_CONDITION && summary.run?.includes(DRY_RUN_SUMMARY) === true
  return ok ? [] : ['a dry-run, and only a dry-run, must write the DRY RUN line to the job summary']
}

/** Story 43.10 AC-2: the dry-run path exists and has zero outward effect. */
function dryRunViolations(workflow: Workflow): string[] {
  return [
    ...dryRunInputViolations(workflow),
    ...publishGateViolations(workflow),
    ...envIndirectionViolations(workflow),
    ...checkoutRefViolations(workflow),
    ...retentionViolations(workflow),
    ...summaryViolations(workflow),
  ]
}

type ValidateRun = { status: number | null; stderr: string; outputs: Map<string, string> }

/** A placeholder commit SHA for the runner environment (not a real object). */
const FAKE_SHA = '1'.repeat(40)
const FEATURE_REF = 'refs/heads/feature/x'

/** The runner-provided environment plus the step's own `env:`, evaluated for this kind of run. */
function validateStepEnv(step: Step, kind: RunKind, tag: string, ref: string, outputFile: string) {
  const env = new Map<string, string>([
    ['PATH', process.env.PATH ?? '/usr/bin:/bin'],
    ['GITHUB_EVENT_NAME', eventNameFor(kind)],
    ['GITHUB_REF', ref],
    ['GITHUB_SHA', FAKE_SHA],
    ['GITHUB_OUTPUT', outputFile],
  ])
  // The event payload the expressions read, for the kind of run being simulated.
  const payload: ExprObject = {
    ...contextFor(kind),
    github: {
      event_name: eventNameFor(kind),
      event: { release: { tag_name: kind === RELEASE_RUN ? tag : null } },
    },
    inputs: kind === RELEASE_RUN ? {} : { ...RUN_INPUTS[kind], tag },
  }
  for (const [name, expression] of Object.entries(step.env ?? {})) {
    env.set(name, String(evaluate(expression, payload) ?? ''))
  }
  return Object.fromEntries(env)
}

function parseOutputs(text: string): Map<string, string> {
  const outputs = new Map<string, string>()
  for (const line of text.split('\n')) {
    const separator = line.indexOf('=')
    if (separator > 0) outputs.set(line.slice(0, separator), line.slice(separator + 1))
  }
  return outputs
}

/** Executes the real validate step's bash script with the given runner environment. */
function runValidateStep(
  workflow: Workflow,
  kind: RunKind,
  overrides: { ref?: string; tag?: string } = {}
): ValidateRun {
  const step = findStep(workflow, (candidate) => candidate.id === 'release')
  if (step?.run === undefined) throw new Error('validate step (id: release) must have a run script')
  const tag = overrides.tag ?? CANDIDATE_TAG
  const ref = overrides.ref ?? (kind === RELEASE_RUN ? `refs/tags/${tag}` : 'refs/heads/main')
  const dir = mkdtempSync(join(tmpdir(), 'cli-release-validate-'))
  try {
    const outputFile = join(dir, 'output')
    writeFileSync(outputFile, '')
    const env = validateStepEnv(step, kind, tag, ref, outputFile)
    const result = spawnSync('bash', ['-c', step.run], { env, encoding: 'utf8' })
    return {
      status: result.status,
      stderr: result.stderr,
      outputs: parseOutputs(readFileSync(outputFile, 'utf8')),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function indexOfStep(workflow: string, marker: string): number {
  const index = workflow.indexOf(marker)
  expect(index, `missing step: ${marker}`).toBeGreaterThan(-1)
  return index
}

describe('cli release workflow contract (Story 43.6 AC-5)', () => {
  it('runs only for published releases or an explicit manual recovery dispatch', () => {
    expect(triggerViolations(parseWorkflow(workflowText()))).toEqual([])
  })

  it.each<[string, string, string]>([
    ['a push trigger', '  release:\n', '  push:\n    tags: [v*]\n  release:\n'],
    ['another release type', 'types: [published]', 'types: [published, created]'],
    ['no tag input', '      tag:\n', '      ref:\n'],
  ])('the trigger check rejects a workflow with %s', (_label, from, to) => {
    const text = workflowText()
    expect(text).toContain(from)
    expect(triggerViolations(parseWorkflow(text.replace(from, to)))).not.toEqual([])
  })

  it('accepts only strict vMAJOR.MINOR.PATCH tags (same regex as container-publish)', () => {
    const workflow = workflowText()
    expect(workflow).toContain('^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$')
    expect(workflow).toMatch(/\$\{TAG#v\}/)
  })

  it('uses least privilege and no secret beyond GITHUB_TOKEN', () => {
    const workflow = workflowText()
    const secrets = [...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map((m) => m[1])
    expect(new Set(secrets)).toEqual(new Set(['GITHUB_TOKEN']))
  })

  it('grants contents: write only to the upload job, never to the job that installs and runs code', () => {
    const workflow = workflowText()
    // No workflow-wide grant: every job states its own permissions.
    expect(workflow).toMatch(/^permissions: \{\}$/m)
    const jobs = workflow.slice(indexOfStep(workflow, '\njobs:\n'))
    const jobPermissions = (job: string): string => {
      const start = indexOfStep(jobs, `\n  ${job}:\n`)
      const next = jobs.slice(start + 1).search(/\n {2}[a-z][a-z-]*:\n/)
      const body = next === -1 ? jobs.slice(start) : jobs.slice(start, start + 1 + next)
      const match = /\n {4}permissions:(?: \{\}|\n((?: {6}[a-z-]+: [a-z]+\n)+))/.exec(body)
      expect(match, `job ${job} must declare permissions`).not.toBeNull()
      return (match?.[1] ?? '').trim()
    }
    expect(jobPermissions('release')).toBe('contents: read')
    expect(jobPermissions('verify')).toBe('')
    expect(jobPermissions('publish')).toBe('contents: write')
    expect(workflow.match(/^ +contents: write$/gm)).toHaveLength(1)
  })

  it('never persists the checkout token into the tree that dependencies and tests run in', () => {
    const workflow = workflowText()
    const checkouts = [...workflow.matchAll(/uses: actions\/checkout@[^\n]+\n((?: {8}.*\n)*)/g)]
    expect(checkouts.length).toBeGreaterThan(0)
    for (const [, withBlock] of checkouts) {
      expect(withBlock).toMatch(/persist-credentials: false/)
    }
  })

  it('serializes real runs in cli-release without cancelling; dry-runs use their own group', () => {
    const workflow = parseWorkflow(workflowText())
    expect(workflow.concurrency?.group).toBe(DRY_RUN_GROUP_TEXT)
    expect(concurrencyViolations(workflow)).toEqual([])
  })

  it.each<[string, string, string]>([
    ['one group shared with dry-runs', `group: ${DRY_RUN_GROUP_TEXT}`, 'group: cli-release'],
    ['a per-ref group', `group: ${DRY_RUN_GROUP_TEXT}`, 'group: cli-release-${{ github.ref }}'],
    [
      'the dry-run branch inverted',
      `group: ${DRY_RUN_GROUP_TEXT}`,
      "group: ${{ inputs.dry_run != true && 'cli-release-dry-run' || 'cli-release' }}",
    ],
    ['cancel-in-progress true', 'cancel-in-progress: false', 'cancel-in-progress: true'],
    ['no concurrency block', '\nconcurrency:\n', '\nx-concurrency:\n'],
  ])('the concurrency check rejects a workflow with %s', (_label, from, to) => {
    const text = workflowText()
    expect(text).toContain(from)
    expect(concurrencyViolations(parseWorkflow(text.replace(from, to)))).not.toEqual([])
  })

  it('tests the unstamped tree, then stamps, builds, bundles, self-verifies and uploads in order', () => {
    const workflow = workflowText()
    const order = [
      'pnpm install --frozen-lockfile',
      'pnpm --filter "@project-vault/cli..." test',
      'scripts/stamp-build-info.ts --version',
      'pnpm --filter "@project-vault/cli..." build',
      'ncc build',
      'Self-verify --version',
      'sha256sum',
      'gh release upload',
    ].map((marker) => indexOfStep(workflow, marker))
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('bundles a single .mjs file without source maps and executes it directly', () => {
    const workflow = workflowText()
    expect(workflow).not.toContain('--source-map')
    expect(workflow).toMatch(/pvault-\$\{VERSION\}\.mjs/)
    expect(workflow).toMatch(/chmod \+x/)
    expect(workflow).toContain('./"$ASSET" --version')
  })

  it('self-verifies the exact --version lines, an empty stderr and no 0.0.1, on Node 20 and 24', () => {
    const workflow = workflowText()
    expect(workflow).toContain('pvault ${VERSION} (commit ${COMMIT})')
    expect(workflow).toContain('agent  ${VERSION} (commit ${COMMIT})')
    expect(workflow).toMatch(/node:\s*\['20',\s*'24'\]/)
    expect(workflow).toContain("grep -c '0\\.0\\.1'")
  })

  it('uploads the asset and its checksum with --clobber', () => {
    const workflow = workflowText()
    expect(workflow).toMatch(/gh release upload[^\n]*--clobber/)
    expect(workflow).toMatch(/\.sha256/)
  })
})

describe('cli release workflow dry-run path (Story 43.10 AC-2)', () => {
  it('declares dry_run, skips publish only for a dry-run, and never interpolates inside run:', () => {
    expect(dryRunViolations(parseWorkflow(workflowText()))).toEqual([])
  })

  it.each<[string, string, string]>([
    ['publish without its if:', `    if: ${PUBLISH_CONDITION}\n`, ''],
    [
      'publish gated by inputs.dry_run == false (text drift that must be caught)',
      `if: ${PUBLISH_CONDITION}`,
      'if: inputs.dry_run == false',
    ],
    ['publish gated only on the input', `if: ${PUBLISH_CONDITION}`, 'if: inputs.dry_run != true'],
    [
      'dry_run defaulting to true',
      '        default: false\n        type: boolean',
      '        default: true\n        type: boolean',
    ],
    [
      'a required dry_run input',
      '        required: false\n        default: false',
      '        required: true\n        default: false',
    ],
    [
      'the checkout ref back on the tag',
      'ref: ${{ steps.release.outputs.ref }}',
      'ref: ${{ steps.release.outputs.tag }}',
    ],
    [
      'a 7-day dry-run artifact',
      'retention-days: ${{ inputs.dry_run == true && 1 || 7 }}',
      'retention-days: 7',
    ],
    ['no DRY_RUN env indirection', '          DRY_RUN: ${{ inputs.dry_run == true }}\n', ''],
    [
      'an input interpolated inside run:',
      'echo "dry_run=$DRY_RUN"',
      'echo "dry_run=${{ inputs.dry_run }}"',
    ],
    [
      'the summary written on every run',
      "if: steps.release.outputs.dry_run == 'true'",
      'if: always()',
    ],
  ])('the dry-run check rejects a workflow with %s', (_label, from, to) => {
    const text = workflowText()
    expect(text).toContain(from)
    expect(dryRunViolations(parseWorkflow(text.replace(from, to)))).not.toEqual([])
  })

  it('the expression evaluator follows GitHub semantics for the conditions above', () => {
    const release = contextFor(RELEASE_RUN)
    const dry = contextFor(DRY_RUN)
    // null == false is TRUE under GitHub's number coercion (null -> 0, false -> 0): a publish gated
    // by `inputs.dry_run == false` would still run on a release event, and it is the exact-text
    // assertion (not the evaluation) that keeps such an edit out.
    const condition = { condition: true }
    const pick = "${{ inputs.dry_run == true && 'a' || 'b' }}"
    expect(evaluate('inputs.dry_run == false', release, condition)).toBe(true)
    expect(evaluate('inputs.dry_run != true', release, condition)).toBe(true)
    expect(evaluate(pick, dry)).toBe('a')
    expect(evaluate(pick, release)).toBe('b')
    expect(evaluate('${{ inputs.dry_run == true && 1 || 7 }}', dry)).toBe(1)
    expect(evaluate("github.event_name == 'RELEASE'", release, condition)).toBe(true)
    expect(evaluate('!(inputs.dry_run)', release, condition)).toBe(true)
    // A field without ${{ }} is a literal, and a mixed field interpolates into a string.
    expect(evaluate(REAL_GROUP, dry)).toBe(REAL_GROUP)
    expect(evaluate('x-${{ github.event_name }}', release)).toBe('x-release')
  })

  it('refuses a real manual dispatch outside main, but lets a dry-run rehearse any branch', () => {
    const workflow = parseWorkflow(workflowText())
    for (const kind of ['dispatch', 'dispatch-no-dry-run-input'] as RunKind[]) {
      const real = runValidateStep(workflow, kind, { ref: FEATURE_REF })
      expect(real.status, kind).not.toBe(0)
      expect(real.stderr, kind).toContain('Manual recovery is only allowed from refs/heads/main')
    }

    const dry = runValidateStep(workflow, DRY_RUN, { ref: FEATURE_REF })
    expect(dry.stderr).toBe('')
    expect(dry.status).toBe(0)
    expect(Object.fromEntries(dry.outputs)).toEqual({
      tag: CANDIDATE_TAG,
      version: '1.3.0',
      ref: FAKE_SHA,
      dry_run: 'true',
    })
  })

  it('checks out the tag for a release event and a real dispatch from main', () => {
    const workflow = parseWorkflow(workflowText())
    for (const kind of REAL_RUNS) {
      const run = runValidateStep(workflow, kind)
      expect(run.stderr, kind).toBe('')
      expect(run.status, kind).toBe(0)
      expect(Object.fromEntries(run.outputs), kind).toEqual({
        tag: CANDIDATE_TAG,
        version: '1.3.0',
        ref: CANDIDATE_TAG,
        dry_run: 'false',
      })
    }
  })

  it.each<string>(['v1.3.0-rc.1', '1.3.0', 'v01.3.0', 'extension-api-v3.24.1'])(
    'a dry-run still rejects the malformed tag %s at validate',
    (tag) => {
      const run = runValidateStep(parseWorkflow(workflowText()), DRY_RUN, { tag })
      expect(run.status).not.toBe(0)
      expect(run.stderr).toContain('Expected vMAJOR.MINOR.PATCH')
    }
  )
})
