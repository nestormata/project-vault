import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// The repository root has no YAML dependency; reuse the `yaml` package apps/api already depends on.
const { parse: parseYaml } = createRequire(resolve(process.cwd(), 'apps/api/package.json'))(
  'yaml'
) as typeof import('yaml')

/** Story 43.6 AC-5 — the `pvault` release workflow's contract. */
function workflowText(): string {
  // Relative to the repository root, which is the working directory vitest runs from.
  return readFileSync('.github/workflows/cli-release.yml', 'utf8')
}

type Step = {
  id?: string
  name?: string
  if?: unknown
  uses?: string
  run?: string
  'continue-on-error'?: unknown
  with?: Record<string, unknown>
  env?: Record<string, unknown>
}

type Job = { if?: unknown; permissions?: unknown; steps?: Step[] }

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
const DISPATCH_RUN: RunKind = 'dispatch'
const NO_DRY_RUN_INPUT_RUN: RunKind = 'dispatch-no-dry-run-input'
const DISPATCH_REAL_RUNS: RunKind[] = [DISPATCH_RUN, NO_DRY_RUN_INPUT_RUN]
const REAL_RUNS: RunKind[] = [RELEASE_RUN, ...DISPATCH_REAL_RUNS]
const ALL_RUNS: RunKind[] = [...REAL_RUNS, DRY_RUN]
const REAL_GROUP = 'cli-release'
const CANDIDATE_TAG = 'v1.3.0'

// Outside workflow_dispatch the `inputs` context is empty, so `inputs.dry_run` is null there.
const RUN_INPUTS = new Map<RunKind, ExprObject>([
  [RELEASE_RUN, {}],
  [DISPATCH_RUN, { tag: CANDIDATE_TAG, dry_run: false }],
  [DRY_RUN, { tag: CANDIDATE_TAG, dry_run: true }],
  [NO_DRY_RUN_INPUT_RUN, { tag: CANDIDATE_TAG }],
])

function runInputs(kind: RunKind): ExprObject {
  return RUN_INPUTS.get(kind) ?? {}
}

function eventNameFor(kind: RunKind): string {
  return kind === RELEASE_RUN ? 'release' : 'workflow_dispatch'
}

function contextFor(kind: RunKind): ExprObject {
  return { github: { event_name: eventNameFor(kind) }, inputs: runInputs(kind) }
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
    current =
      current !== null && typeof current === 'object'
        ? new Map(Object.entries(current)).get(part)
        : undefined
  }
  return current ?? null
}

function literal(lexeme: string, context: ExprObject): ExprValue {
  if (lexeme.startsWith("'")) return lexeme.slice(1, -1).replaceAll("''", "'")
  if (/^\d+$/.test(lexeme)) return Number(lexeme)
  const keywords = new Map<string, ExprValue>([
    ['true', true],
    ['false', false],
    ['null', null],
  ])
  return keywords.has(lexeme) ? (keywords.get(lexeme) ?? null) : lookup(lexeme, context)
}

/** Recursive-descent evaluation of one expression: `||` < `&&` < `==`/`!=` < `!`/`( )`. */
class ExpressionEvaluator {
  private position = 0

  constructor(
    private readonly lexemes: string[],
    private readonly context: ExprObject
  ) {}

  run(): ExprValue {
    const value = this.or()
    if (this.position !== this.lexemes.length)
      throw new Error(`trailing tokens: ${this.lexemes.join(' ')}`)
    return value
  }

  private next(): string {
    const lexeme = this.lexemes[this.position]
    if (lexeme === undefined) throw new Error(`unexpected end: ${this.lexemes.join(' ')}`)
    this.position += 1
    return lexeme
  }

  private or(): ExprValue {
    let left = this.and()
    while (this.lexemes[this.position] === '||') {
      this.position += 1
      const right = this.and()
      left = truthy(left) ? left : right
    }
    return left
  }

  private and(): ExprValue {
    let left = this.comparison()
    while (this.lexemes[this.position] === '&&') {
      this.position += 1
      const right = this.comparison()
      left = truthy(left) ? right : left
    }
    return left
  }

  private comparison(): ExprValue {
    let left = this.unary()
    let operator = this.lexemes[this.position]
    while (operator === '==' || operator === '!=') {
      this.position += 1
      const equal = looseEquals(left, this.unary())
      left = operator === '==' ? equal : !equal
      operator = this.lexemes[this.position]
    }
    return left
  }

  private unary(): ExprValue {
    const lexeme = this.next()
    if (lexeme === '!') return !truthy(this.unary())
    if (lexeme !== '(') return literal(lexeme, this.context)
    const value = this.or()
    if (this.next() !== ')') throw new Error(`missing ) in ${this.lexemes.join(' ')}`)
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
  const whole = /^\$\{\{([^}]*)\}\}$/.exec(text)?.[1]
  if (whole !== undefined) return evaluateExpression(whole, context)
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
  const jobs = new Map(Object.entries(workflow.jobs ?? {}))
  const violations = ['release', 'verify']
    .filter((job) => jobs.get(job)?.if !== undefined)
    .map((job) => `${job} must run for every kind of run (no if:)`)
  const gate = jobs.get('publish')?.if
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

const REAL_CHECKOUT_CONDITION = "steps.release.outputs.dry_run != 'true'"
const DRY_RUN_CHECKOUT_CONDITION = SUMMARY_CONDITION
const TAG_REF = '${{ steps.release.outputs.tag }}'
/** The dry-run checkout step's text up to its (ref-less) `with:` block, for mutation cases. */
const DRY_RUN_CHECKOUT_HEAD = `        if: ${DRY_RUN_CHECKOUT_CONDITION}\n        uses: actions/checkout@v7\n`
const DRY_RUN_CHECKOUT_WITH = `${DRY_RUN_CHECKOUT_HEAD}        with:\n`

/** The validate step's `dry_run` output, as the checkout `if:` conditions read it. */
function stepsContextFor(dryRun: string): ExprObject {
  return { steps: { release: { outputs: { dry_run: dryRun } } } }
}

/**
 * Two mutually exclusive checkouts, never one computed ref: a real run checks out the validated tag
 * (exactly as before 43.10), a dry-run takes the default checkout of the dispatching commit with no
 * `ref:` at all. A step-output-computed ref that can resolve to the dispatching commit is what
 * CodeQL's actions/cache-poisoning query flags as a privileged checkout of untrusted code.
 */
function checkoutShapeViolations(real: Step | undefined, dry: Step | undefined): string[] {
  const violations: string[] = []
  if (real?.with?.ref !== TAG_REF) {
    violations.push(`the real-run checkout (if: ${REAL_CHECKOUT_CONDITION}) must ref ${TAG_REF}`)
  }
  if (dry?.with === undefined || 'ref' in dry.with) {
    violations.push(`the dry-run checkout (if: ${DRY_RUN_CHECKOUT_CONDITION}) must have no ref:`)
  }
  return violations
}

/** The checkouts that run for a given `dry_run` output; a step without `if:` always runs. */
function runningCheckouts(checkouts: Step[], dryRun: string): Step[] {
  return checkouts.filter(
    (step) =>
      step.if === undefined ||
      truthy(evaluate(step.if, stepsContextFor(dryRun), { condition: true }))
  )
}

function checkoutRefViolations(workflow: Workflow): string[] {
  const checkouts = releaseSteps(workflow).filter(usesAction('actions/checkout@'))
  if (checkouts.length !== 2) return ['the release job must have exactly two checkout steps']
  const real = checkouts.find((step) => step.if === REAL_CHECKOUT_CONDITION)
  const dry = checkouts.find((step) => step.if === DRY_RUN_CHECKOUT_CONDITION)
  const violations = checkoutShapeViolations(real, dry)
  for (const [dryRun, expected] of [
    ['true', dry],
    ['false', real],
  ] as const) {
    const running = runningCheckouts(checkouts, dryRun)
    if (running.length !== 1 || running[0] !== expected) {
      violations.push(`exactly the right checkout must run when dry_run is '${dryRun}'`)
    }
  }
  return violations
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
/**
 * Runs the step script (passed in $STEP_SCRIPT, removed before the step sees its environment) with
 * $GITHUB_OUTPUT pointing at a file the wrapper owns, then prints that file as the wrapper's only
 * stdout. The step's own stdout is not part of the contract and is discarded; stderr passes through.
 */
const RUN_WITH_GITHUB_OUTPUT = [
  'script="$STEP_SCRIPT"; unset STEP_SCRIPT',
  'out="$(mktemp)" || exit 97',
  'GITHUB_OUTPUT="$out" bash -c "$script" >/dev/null; status=$?',
  'cat "$out"; rm -f "$out"; exit "$status"',
].join('\n')

/** The runner-provided environment plus the step's own `env:`, evaluated for this kind of run. */
function validateStepEnv(step: Step, kind: RunKind, tag: string, ref: string) {
  const env = new Map<string, string>([
    ['PATH', process.env.PATH ?? '/usr/bin:/bin'],
    ['GITHUB_EVENT_NAME', eventNameFor(kind)],
    ['GITHUB_REF', ref],
    ['GITHUB_SHA', FAKE_SHA],
  ])
  // The event payload the expressions read, for the kind of run being simulated.
  const payload: ExprObject = {
    ...contextFor(kind),
    github: {
      event_name: eventNameFor(kind),
      event: { release: { tag_name: kind === RELEASE_RUN ? tag : null } },
    },
    inputs: kind === RELEASE_RUN ? {} : { ...runInputs(kind), tag },
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
  const env = { ...validateStepEnv(step, kind, tag, ref), STEP_SCRIPT: step.run }
  const result = spawnSync('bash', ['-c', RUN_WITH_GITHUB_OUTPUT], { env, encoding: 'utf8' })
  return { status: result.status, stderr: result.stderr, outputs: parseOutputs(result.stdout) }
}

function indexOfStep(workflow: string, marker: string): number {
  const index = workflow.indexOf(marker)
  expect(index, `missing step: ${marker}`).toBeGreaterThan(-1)
  return index
}

// Story 43.21 AC-1: the test step runs exactly the CLI and its agent. A pnpm dependency closure
// (`cli...`) pulls in @project-vault/api, a devDependency of the CLI, and with it the whole API
// suite, which ci.yml already runs on the same SHA (run 36368061666 timed out on it).
const TEST_STEP_NAME = 'Test the CLI and its agent (unstamped)'
const TEST_STEP_COMMAND = 'pnpm --filter @project-vault/cli --filter @project-vault/agent test'
const TEST_STEP_SELECTORS = ['@project-vault/agent', '@project-vault/cli']
const BUILD_STEP_COMMAND = 'pnpm --filter "@project-vault/cli..." build'

function unquote(word: string): string {
  return word.replaceAll(/^["']|["']$/g, '')
}

/** The `--filter` selectors of a `pnpm --filter <a> [--filter <b> ...] test` command, or why not. */
function filterSelectors(run: string): { selectors: string[]; violations: string[] } {
  const words = run.trim().split(/\s+/).map(unquote)
  const violations: string[] = []
  if (words[0] !== 'pnpm' || words.at(-1) !== 'test') {
    violations.push(`not a "pnpm ... test" command: ${run}`)
  }
  const args = words.slice(1, -1)
  const selectors: string[] = []
  while (args.length > 0) {
    const [flag, selector] = args.splice(0, 2)
    if (flag !== '--filter' || selector === undefined) {
      violations.push(`unexpected argument: ${flag}`)
      break
    }
    selectors.push(selector)
  }
  return { selectors, violations }
}

// A pnpm/turbo/vitest test invocation in any other release step would widen the scope again.
const OTHER_TEST_RUN = /\b(?:pnpm|turbo)\b[^\n]*\btest\b|\bvitest\b/

/** A skipped or failure-tolerant test step, or tests run elsewhere, would defeat the scope check. */
function testStepIsolationViolations(workflow: Workflow, step: Step): string[] {
  const violations: string[] = []
  if (step.if !== undefined) violations.push(`the test step must not be conditional: ${step.if}`)
  if (step['continue-on-error'] !== undefined) {
    violations.push('the test step must not set continue-on-error')
  }
  for (const other of releaseSteps(workflow)) {
    if (other !== step && other.run !== undefined && OTHER_TEST_RUN.test(other.run)) {
      violations.push(`only the test step may run tests, also found in: ${other.name ?? other.run}`)
    }
  }
  return violations
}

function testStepScopeViolations(workflow: Workflow): string[] {
  const step = findStep(workflow, (candidate) => candidate.name === TEST_STEP_NAME)
  if (step?.run === undefined) return [`missing step: ${TEST_STEP_NAME}`]
  const { selectors, violations } = filterSelectors(step.run)
  violations.push(...testStepIsolationViolations(workflow, step))
  for (const selector of selectors.filter((s) => s.includes('...') || s.includes('^'))) {
    violations.push(`selector widens to a dependency/dependent closure: ${selector}`)
  }
  const selected = [...new Set(selectors.map((s) => s.replaceAll(/\^|\.{3}/g, '')))].sort()
  if (selected.join(',') !== TEST_STEP_SELECTORS.join(',')) {
    violations.push(`must select exactly ${TEST_STEP_SELECTORS.join(' and ')}, got: ${step.run}`)
  }
  return violations
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
    const jobs = new Map(Object.entries(parseWorkflow(workflow).jobs ?? {}))
    const jobPermissions = (job: string): unknown => {
      const permissions = jobs.get(job)?.permissions
      expect(permissions, `job ${job} must declare permissions`).toBeDefined()
      return permissions
    }
    expect(jobPermissions('release')).toEqual({ contents: 'read' })
    expect(jobPermissions('verify')).toEqual({})
    expect(jobPermissions('publish')).toEqual({ contents: 'write' })
    expect(workflow.match(/^ +contents: write$/gm)).toHaveLength(1)
  })

  it('never persists the checkout token into the tree that dependencies and tests run in', () => {
    const workflow = workflowText()
    const checkouts = Object.values(parseWorkflow(workflow).jobs ?? {})
      .flatMap((job) => job.steps ?? [])
      .filter(usesAction('actions/checkout@'))
    expect(checkouts.length).toBeGreaterThanOrEqual(2)
    for (const checkout of checkouts) {
      expect(checkout.with?.['fetch-depth']).toBe(1)
      expect(checkout.with?.['persist-credentials']).toBe(false)
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
      'id: release',
      `ref: ${TAG_REF}`,
      `if: ${DRY_RUN_CHECKOUT_CONDITION}\n        uses: actions/checkout@`,
      'pnpm install --frozen-lockfile',
      TEST_STEP_COMMAND,
      'scripts/stamp-build-info.ts --version',
      BUILD_STEP_COMMAND,
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
      'the dry-run checkout given the tag ref',
      DRY_RUN_CHECKOUT_WITH,
      `${DRY_RUN_CHECKOUT_WITH}          ref: ${TAG_REF}\n`,
    ],
    [
      'the dry-run checkout given an explicit github.sha ref',
      DRY_RUN_CHECKOUT_WITH,
      `${DRY_RUN_CHECKOUT_WITH}          ref: \${{ github.sha }}\n`,
    ],
    ['the real checkout without the tag ref', `          ref: ${TAG_REF}\n`, ''],
    [
      'the real checkout on a computed ref',
      `ref: ${TAG_REF}`,
      'ref: ${{ steps.release.outputs.ref }}',
    ],
    ['the real checkout without its if:', `        if: ${REAL_CHECKOUT_CONDITION}\n`, ''],
    [
      'the dry-run checkout without its if:',
      DRY_RUN_CHECKOUT_HEAD,
      '        uses: actions/checkout@v7\n',
    ],
    [
      'both checkouts running for a real run',
      `        if: ${REAL_CHECKOUT_CONDITION}\n`,
      "        if: steps.release.outputs.dry_run != 'yes'\n",
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
      "job summary\n        if: steps.release.outputs.dry_run == 'true'",
      'job summary\n        if: always()',
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
    for (const kind of DISPATCH_REAL_RUNS) {
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
      dry_run: 'true',
    })
  })

  it('validates the tag and reports dry_run false for a release event and a real dispatch', () => {
    const workflow = parseWorkflow(workflowText())
    for (const kind of REAL_RUNS) {
      const run = runValidateStep(workflow, kind)
      expect(run.stderr, kind).toBe('')
      expect(run.status, kind).toBe(0)
      expect(Object.fromEntries(run.outputs), kind).toEqual({
        tag: CANDIDATE_TAG,
        version: '1.3.0',
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

describe('cli release workflow test-step scope (Story 43.21 AC-1)', () => {
  it('tests exactly the CLI and its agent, with no pnpm dependency or dependent closure', () => {
    expect(testStepScopeViolations(parseWorkflow(workflowText()))).toEqual([])
  })

  it('keeps the dependency closure on the build step (the bundle needs every workspace dependency)', () => {
    expect(workflowText()).toContain(BUILD_STEP_COMMAND)
  })

  it.each<[string, string]>([
    [
      'the CLI with its dependency closure (the 36368061666 regression)',
      'pnpm --filter "@project-vault/cli..." test',
    ],
    [
      'the closure next to the agent',
      'pnpm --filter "@project-vault/cli..." --filter @project-vault/agent test',
    ],
    ['the CLI with its dependents', 'pnpm --filter "...@project-vault/cli" test'],
    ['the CLI alone (agent dropped)', 'pnpm --filter @project-vault/cli test'],
    ['a recursive run', 'pnpm -r test'],
    ['a whole-repo run', 'pnpm test'],
    ['only the dependencies of the CLI', 'pnpm --filter "@project-vault/cli^..." test'],
  ])('the scope check rejects a test step running %s', (_label, command) => {
    const text = workflowText()
    expect(text).toContain(`run: ${TEST_STEP_COMMAND}\n`)
    const mutated = text.replace(`run: ${TEST_STEP_COMMAND}\n`, `run: ${command}\n`)
    expect(testStepScopeViolations(parseWorkflow(mutated))).not.toEqual([])
  })

  const BUILD_LINE = `          ${BUILD_STEP_COMMAND}\n`
  it.each<[string, string, string]>([
    [
      'a skipped test step',
      `name: ${TEST_STEP_NAME}\n`,
      `name: ${TEST_STEP_NAME}\n        if: false\n`,
    ],
    [
      'a failure-tolerant test step',
      `name: ${TEST_STEP_NAME}\n`,
      `name: ${TEST_STEP_NAME}\n        continue-on-error: true\n`,
    ],
    ['a whole-repo test run in another step', BUILD_LINE, `${BUILD_LINE}          pnpm -r test\n`],
    [
      'a turbo test run in another step',
      BUILD_LINE,
      `${BUILD_LINE}          pnpm turbo test --filter=@project-vault/api\n`,
    ],
  ])('the scope check rejects %s', (_label, from, to) => {
    const text = workflowText()
    expect(text).toContain(from)
    expect(testStepScopeViolations(parseWorkflow(text.replace(from, to)))).not.toEqual([])
  })

  it('reports a missing test step', () => {
    const mutated = workflowText().replace(`name: ${TEST_STEP_NAME}`, 'name: Test something else')
    expect(testStepScopeViolations(parseWorkflow(mutated))).toEqual([
      `missing step: ${TEST_STEP_NAME}`,
    ])
  })
})
