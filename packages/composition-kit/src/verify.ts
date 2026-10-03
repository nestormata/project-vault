// Story 68.9 AC-9: `pv-verify`, the one command that runs PV's web guards and PV's unit tests over a
// composed tree. Steps run in a fixed order and a failing step never stops the later ones (one run
// reports every finding). Nothing here refuses what a pack may do: every check is either PV's own
// rule applied to the composed files or an integrity check of the composition itself.
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { compose } from './compose.js'
import { exclusionNotes, securityRelevant } from './excluded-tests.js'
import { GUARD_ENTRIES_PATH, sectionHashes } from './guard-entries.js'
import { readLock, type CompositionLock } from './lock.js'
import { runGuards, type GuardsResult } from './verify-guards.js'
import { runVitest, suiteFailures, vitestBin, type VitestReport } from './verify-run.js'

export type VerifyStep = 'guards' | 'tests'

export interface VerifyOptions {
  appRoot: string
  hostDir: string
  /** When given, the preflight regenerates the lock from the pack (`pv-compose --check`). */
  packRoot?: string
  only?: VerifyStep
  explain?: boolean
}

export interface TestsResult {
  ok: boolean
  run: number
  failed: number
  excluded: string[]
  failures: string[]
  problems: string[]
}

export interface VerifyReport {
  ok: boolean
  preflight: { ok: boolean; problems: string[]; regenerated: boolean }
  guards?: GuardsResult
  tests?: TestsResult
  warnings: string[]
  entries: Record<string, number>
  /** Composed path -> pack source path, for every materialized file (`--explain`). */
  sources: Record<string, string>
}

const LOCK_FILE = 'composition.lock.json'

function lockProblems(appRoot: string): { lock?: CompositionLock; problems: string[] } {
  const read = readLock(join(appRoot, LOCK_FILE))
  if (read === null) {
    return { problems: [`no committed ${LOCK_FILE} in the app root; run pv-compose and commit it`] }
  }
  if (read.lock === undefined) return { problems: [read.problem ?? `${LOCK_FILE} is unreadable`] }
  return { lock: read.lock, problems: [] }
}

function tamperProblems(appRoot: string, lock: CompositionLock): string[] {
  if (lock.guardEntries === undefined) return []
  const path = join(appRoot, GUARD_ENTRIES_PATH)
  const actual = sectionHashes(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {})
  const differing = Object.entries(lock.guardEntries)
    .filter(([section, hash]) => actual[section] !== hash)
    .map(([section]) => section)
  return differing.length === 0
    ? []
    : [
        `generated guard entries differ from ${LOCK_FILE} (${differing.join(', ')}); re-run pv-compose`,
      ]
}

function hostRelease(hostDir: string): string | null {
  try {
    const tuple = JSON.parse(
      readFileSync(join(hostDir, 'manifests', 'compatibility.json'), 'utf8')
    ) as { pvRelease?: string }
    return tuple.pvRelease ?? null
  } catch {
    return null
  }
}

async function preflight(
  options: VerifyOptions
): Promise<{ lock?: CompositionLock; problems: string[] }> {
  const found = lockProblems(options.appRoot)
  if (found.lock === undefined) return found
  const lock = found.lock
  if (options.packRoot !== undefined) {
    const checked = await compose({
      appRoot: options.appRoot,
      packRoot: options.packRoot,
      hostDir: options.hostDir,
      check: true,
    })
    if (!checked.ok) return { lock, problems: checked.messages }
  } else {
    const release = hostRelease(options.hostDir)
    if (release !== null && release !== lock.compatibility.pvRelease) {
      return {
        lock,
        problems: [
          `${LOCK_FILE} was written against PV ${lock.compatibility.pvRelease} but the web-host is ${release}; ${LOCK_FILE} is out of date, run pv-compose`,
        ],
      }
    }
  }
  return { lock, problems: tamperProblems(options.appRoot, lock) }
}

function testsStep(options: VerifyOptions, lock: CompositionLock): TestsResult {
  const excluded = [...lock.excludedPvTests]
  const empty = { ok: false, run: 0, failed: 0, excluded, failures: [] as string[] }
  const bin = vitestBin(options.appRoot)
  if (bin === null) {
    return {
      ...empty,
      problems: ['cannot find vitest from the app root; install vitest in the app'],
    }
  }
  const dir = join(options.appRoot, '.pv-compose')
  mkdirSync(dir, { recursive: true })
  const config = join(dir, 'verify.vitest.config.mjs')
  writeFileSync(
    config,
    [
      "import { vitestConfig } from '@project-vault/web-host/vitest.config'",
      `export default vitestConfig({}, { appRoot: ${JSON.stringify(options.appRoot)}, composedRoot: ${JSON.stringify(options.appRoot)} })`,
      '',
    ].join('\n')
  )
  // The guards' scan root belongs to the guards step only: CM's own tests must not see it.
  const run = runVitest({
    bin,
    root: options.appRoot,
    config,
    reportFile: join(dir, 'verify-tests.json'),
    withoutEnv: ['PV_GUARD_APP_ROOT', 'PV_GUARD_EXEMPT_FILES'],
  })
  if (run.report === null) {
    return {
      ...empty,
      problems: [
        `vitest exited with code ${String(run.status)} and wrote no report: ${run.stderrTail}`,
      ],
    }
  }
  const report: VitestReport = run.report
  return {
    ok: run.status === 0 && report.numFailedTests === 0,
    run: report.numTotalTests,
    failed: report.numFailedTests,
    excluded,
    failures: report.testResults.flatMap((suite) =>
      suiteFailures(suite).map((line) => `${suite.name.slice(options.appRoot.length + 1)}: ${line}`)
    ),
    problems:
      run.status === 0 || report.numFailedTests > 0
        ? []
        : [`vitest exited with code ${String(run.status)}`],
  }
}

function warningsOf(lock: CompositionLock, run: number, guards?: GuardsResult): string[] {
  const total = run + lock.excludedPvTests.length
  const notes = exclusionNotes(lock.excludedPvTests, total)
  return [
    ...securityRelevant(lock.excludedPvTests).map(
      (test) => `WARN excluded security-relevant PV test ${test}`
    ),
    ...notes.filter((note) => note.includes('PV tests excluded')).map((note) => `WARN ${note}`),
    ...(guards?.overridden ?? []).map(
      (file) => `guard-file-overridden ${file} (the pristine PV copy ran)`
    ),
  ]
}

function entryCounts(lock: CompositionLock): Record<string, number> {
  return {
    overrides: lock.overrides.length,
    additions: lock.additions.length,
    removals: lock.removals.length,
    guardEntrySections: Object.keys(lock.guardEntries ?? {}).length,
    excludedPvTests: lock.excludedPvTests.length,
  }
}

async function runSteps(
  options: VerifyOptions,
  lock: CompositionLock
): Promise<{ guards?: GuardsResult; tests?: TestsResult }> {
  const guards =
    options.only === 'tests'
      ? undefined
      : await runGuards({ appRoot: options.appRoot, hostDir: options.hostDir, lock })
  const tests = options.only === 'guards' ? undefined : testsStep(options, lock)
  return { ...(guards === undefined ? {} : { guards }), ...(tests === undefined ? {} : { tests }) }
}

function reportExtras(
  lock: CompositionLock | undefined,
  steps: { guards?: GuardsResult; tests?: TestsResult }
): Pick<VerifyReport, 'warnings' | 'entries' | 'sources'> {
  if (lock === undefined) return { warnings: [], entries: {}, sources: {} }
  return {
    warnings: warningsOf(lock, steps.tests?.run ?? 0, steps.guards),
    entries: entryCounts(lock),
    sources: Object.fromEntries(lock.materialized.map((entry) => [entry.path, entry.source])),
  }
}

/** One verify run. Never throws for a finding: the report says what failed. */
export async function verify(options: VerifyOptions): Promise<VerifyReport> {
  const checked = await preflight(options)
  const steps = checked.lock === undefined ? {} : await runSteps(options, checked.lock)
  const clean = checked.problems.length === 0
  return {
    ok:
      checked.lock !== undefined &&
      clean &&
      (steps.guards?.ok ?? true) &&
      (steps.tests?.ok ?? true),
    preflight: {
      ok: clean,
      problems: checked.problems,
      regenerated: options.packRoot !== undefined,
    },
    ...steps,
    ...reportExtras(checked.lock, steps),
  }
}

/** A second run on one app root fails fast instead of racing vitest's cache; a stale lock (its
 * process is gone) is replaced. Returns a release function, or the pid that holds the lock. */
export function acquireRunLock(appRoot: string): { release: () => void } | { heldBy: number } {
  const dir = join(appRoot, '.pv-compose')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'verify.lock')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx')
      writeFileSync(fd, String(process.pid))
      closeSync(fd)
      return { release: () => rmSync(path, { force: true }) }
    } catch {
      const pid = Number(readFileSync(path, 'utf8'))
      if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) return { heldBy: pid }
      rmSync(path, { force: true })
    }
  }
  return { heldBy: 0 }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
