// Story 68.9 AC-9 step 2: PV's web guards over a composed tree. The registry (`manifests/guards.json`)
// comes from the web-host; a test guard runs from a scratch copy of the host's PRISTINE guard file
// and helper closure (a pack that overrides a guard or one of its helpers cannot blind it), with
// `PV_GUARD_APP_ROOT` pointing at the REAL composed app. A script guard is imported from the host.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sha256Hex } from './hash.js'
import type { CompositionLock } from './lock.js'
import { compareCodeUnits } from './paths.js'
import {
  failureHead,
  runVitest,
  suiteFailures,
  vitestBin,
  type VitestReport,
  type VitestSuite,
} from './verify-run.js'

export const GUARD_ROOT_ENV = 'PV_GUARD_APP_ROOT'
export const EXEMPT_ENV = 'PV_GUARD_EXEMPT_FILES'
const SUPPORTED_REGISTRY = 1
/** Guards a later story adds (68-4's coverage guard, 68-10's monolithic-region guard): their absence
 * from an older web-host is not a weakening, so it is reported, not failed. */
const PV_DUTY_GUARDS = ['injection-point-coverage', 'monolithic-region'] as const
const SCOPES = new Set(['all-files', 'pv-originated-only'])

export interface GuardRegistryEntry {
  id: string
  kind: 'test' | 'script'
  file: string
  scope: string
  closure?: { file: string; sha256: string }[]
  /** Modules the guard also asserts about, staged from the composed app (an override is seen). */
  subjects?: string[]
  subjectClosure?: string[]
}

export interface GuardOutcome {
  id: string
  kind: string
  ok: boolean
  ms: number
  failures: string[]
}

export interface GuardsResult {
  ok: boolean
  outcomes: GuardOutcome[]
  skipped: string[]
  /** Pristine guard files that replaced a pack's copy (override or removal). */
  overridden: string[]
  problems: string[]
}

export function readRegistry(hostDir: string): { guards?: GuardRegistryEntry[]; problem?: string } {
  const path = join(hostDir, 'manifests', 'guards.json')
  if (!existsSync(path)) {
    return {
      problem:
        'this web-host does not publish its guard registry (manifests/guards.json); upgrade @project-vault/web-host',
    }
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      schemaVersion?: number
      guards?: GuardRegistryEntry[]
    }
    if (raw.schemaVersion !== SUPPORTED_REGISTRY || !Array.isArray(raw.guards)) {
      return {
        problem: `manifests/guards.json has an unsupported schemaVersion (${String(raw.schemaVersion)}); upgrade @project-vault/composition-kit`,
      }
    }
    return { guards: raw.guards }
  } catch {
    return { problem: 'manifests/guards.json is not valid JSON' }
  }
}

function fileHash(path: string): string | null {
  return existsSync(path) ? sha256Hex(readFileSync(path)) : null
}

function copyInto(scratch: string, hostDir: string, rel: string): void {
  mkdirSync(dirname(join(scratch, rel)), { recursive: true })
  copyFileSync(join(hostDir, rel), join(scratch, rel))
}

interface Staged {
  testFiles: string[]
  overridden: string[]
  problems: string[]
}

interface StageContext {
  scratch: string
  hostDir: string
  appRoot: string
}

/** Copies one guard file from the host into the scratch tree and notes an override or a drift. */
function stageFile(
  context: StageContext,
  guard: GuardRegistryEntry,
  entry: { file: string; sha256: string | null },
  staged: Staged
): void {
  const host = fileHash(join(context.hostDir, entry.file))
  if (host === null) {
    staged.problems.push(
      `guard ${guard.id}: ${entry.file} is in the registry but not in the web-host`
    )
    return
  }
  if (entry.sha256 !== null && entry.sha256 !== host) {
    staged.problems.push(
      `guard ${guard.id}: ${entry.file} differs from the hash in manifests/guards.json`
    )
  }
  copyInto(context.scratch, context.hostDir, entry.file)
  if (fileHash(join(context.appRoot, entry.file)) !== host) staged.overridden.push(entry.file)
}

/** A subject module (and what it imports) comes from the COMPOSED app: the guard asserts about the
 * code that will run, so a pack's override of it is what the guard sees. */
function stageSubject(
  context: StageContext,
  guard: GuardRegistryEntry,
  file: string,
  staged: Staged
): void {
  const source = join(context.appRoot, file)
  if (!existsSync(source)) {
    staged.problems.push(`guard ${guard.id}: its subject ${file} is not in the composed tree`)
    return
  }
  mkdirSync(dirname(join(context.scratch, file)), { recursive: true })
  copyFileSync(source, join(context.scratch, file))
}

/** Copies each test guard and its closure from the host into a fresh scratch directory. */
function stage(context: StageContext, guards: GuardRegistryEntry[]): Staged {
  rmSync(context.scratch, { recursive: true, force: true })
  mkdirSync(context.scratch, { recursive: true })
  const staged: Staged = { testFiles: [], overridden: [], problems: [] }
  const seen = new Set<string>()
  for (const guard of guards.filter((entry) => entry.kind === 'test')) {
    staged.testFiles.push(guard.file)
    for (const entry of [{ file: guard.file, sha256: null }, ...(guard.closure ?? [])]) {
      if (seen.has(entry.file)) continue
      seen.add(entry.file)
      stageFile(context, guard, entry, staged)
    }
    for (const file of [...(guard.subjects ?? []), ...(guard.subjectClosure ?? [])]) {
      if (seen.has(file)) continue
      seen.add(file)
      stageSubject(context, guard, file, staged)
    }
  }
  staged.overridden.sort(compareCodeUnits)
  return staged
}

function configText(scratch: string, testFiles: readonly string[]): string {
  const libDir = JSON.stringify(`${scratch}/src/lib/`)
  return [
    'export default {',
    `  test: { include: ${JSON.stringify(testFiles)}, environment: 'node' },`,
    String.raw`  resolve: { alias: [{ find: /^\$lib\//, replacement: ${libDir} }] },`,
    '}',
    '',
  ].join('\n')
}

/** Composed paths that CM wrote or changed: what a PV-duty guard exempts. */
export function cmOriginatedFiles(lock: CompositionLock): string[] {
  return [
    ...lock.additions.map((entry) => entry.path),
    ...lock.overrides.map((entry) => entry.path),
    ...lock.materialized.map((entry) => entry.path),
  ].sort(compareCodeUnits)
}

function outcomeOf(guard: GuardRegistryEntry, report: VitestReport): GuardOutcome {
  const suite: VitestSuite | undefined = report.testResults.find((entry) =>
    entry.name.replaceAll('\\', '/').endsWith(`/${guard.file}`)
  )
  if (suite === undefined) {
    return { id: guard.id, kind: guard.kind, ok: false, ms: 0, failures: ['the guard did not run'] }
  }
  const failures = suiteFailures(suite)
  const ms = Math.max(0, (suite.endTime ?? 0) - (suite.startTime ?? 0))
  return { id: guard.id, kind: guard.kind, ok: failures.length === 0, ms, failures }
}

async function scriptOutcome(
  hostDir: string,
  guard: GuardRegistryEntry,
  appRoot: string
): Promise<GuardOutcome> {
  const started = Date.now()
  try {
    const module = (await import(pathToFileURL(join(hostDir, guard.file)).href)) as {
      runGuard?: (root: string) => { file: string; message: string }[]
    }
    if (typeof module.runGuard !== 'function') {
      return {
        id: guard.id,
        kind: 'script',
        ok: false,
        ms: 0,
        failures: [`${guard.file} exports no runGuard(appRoot)`],
      }
    }
    const findings = module.runGuard(appRoot)
    return {
      id: guard.id,
      kind: 'script',
      ok: findings.length === 0,
      ms: Date.now() - started,
      failures: findings.map((finding) => finding.message),
    }
  } catch (error) {
    return {
      id: guard.id,
      kind: 'script',
      ok: false,
      ms: 0,
      failures: [`could not run: ${failureHead((error as Error).message)}`],
    }
  }
}

function testGuardOutcomes(
  guards: GuardRegistryEntry[],
  staged: Staged,
  appRoot: string,
  scratch: string,
  lock: CompositionLock
): { outcomes: GuardOutcome[]; problems: string[] } {
  const tests = guards.filter((guard) => guard.kind === 'test')
  if (tests.length === 0) return { outcomes: [], problems: [] }
  const bin = vitestBin(appRoot)
  if (bin === null) {
    return {
      outcomes: [],
      problems: ['cannot find vitest from the app root; install vitest in the app'],
    }
  }
  const config = join(scratch, 'vitest.guards.config.mjs')
  writeFileSync(config, configText(scratch, staged.testFiles))
  const run = runVitest({
    bin,
    root: scratch,
    config,
    reportFile: join(scratch, 'result.json'),
    extraEnv: { [GUARD_ROOT_ENV]: appRoot, [EXEMPT_ENV]: JSON.stringify(cmOriginatedFiles(lock)) },
  })
  if (run.report === null) {
    return {
      outcomes: [],
      problems: [
        `vitest exited with code ${String(run.status)} and wrote no report: ${run.stderrTail}`,
      ],
    }
  }
  return {
    outcomes: tests.map((guard) => outcomeOf(guard, run.report as VitestReport)),
    problems: [],
  }
}

export async function runGuards(input: {
  appRoot: string
  hostDir: string
  lock: CompositionLock
}): Promise<GuardsResult> {
  const registry = readRegistry(input.hostDir)
  if (registry.guards === undefined) {
    return {
      ok: false,
      outcomes: [],
      skipped: [],
      overridden: [],
      problems: [registry.problem ?? ''],
    }
  }
  const guards = registry.guards
  const scratch = join(input.appRoot, '.pv-compose', 'guard-run')
  const problems = guards
    .filter((guard) => !SCOPES.has(guard.scope))
    .map(
      (guard) =>
        `guard ${guard.id} has an unknown scope "${guard.scope}"; upgrade @project-vault/composition-kit`
    )
  const staged = stage({ scratch, hostDir: input.hostDir, appRoot: input.appRoot }, guards)
  problems.push(...staged.problems)
  const tests = testGuardOutcomes(guards, staged, input.appRoot, scratch, input.lock)
  problems.push(...tests.problems)
  const scripts = await Promise.all(
    guards
      .filter((guard) => guard.kind === 'script')
      .map((guard) => scriptOutcome(input.hostDir, guard, input.appRoot))
  )
  const outcomes = [...scripts, ...tests.outcomes].sort((a, b) => compareCodeUnits(a.id, b.id))
  const known = new Set(guards.map((guard) => guard.id))
  return {
    ok: problems.length === 0 && outcomes.every((outcome) => outcome.ok),
    outcomes,
    skipped: PV_DUTY_GUARDS.filter((id) => !known.has(id)).map(
      (id) => `${id}: skipped (not published by this web-host)`
    ),
    overridden: staged.overridden,
    problems,
  }
}
