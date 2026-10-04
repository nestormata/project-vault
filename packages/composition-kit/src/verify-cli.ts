#!/usr/bin/env node
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  EXIT,
  NO_HOST_MESSAGE,
  hostDirectory,
  locateHost,
  resolveOptional,
  runAsScript,
  usageError,
  type CliIo,
} from './cli-shared.js'
import {
  acquireRunLock,
  extractClassifications,
  verify,
  type VerifyOptions,
  type VerifyReport,
} from './verify.js'

const USAGE = `Usage: pv-verify [options]

Runs PV's web guards and PV's unit tests over a composed app, in this order, and reports every
finding in one run: preflight (the lock is current), guards, tests. There is no flag that skips,
disables or ignores a step or a guard.

  --app <dir>        the composed app root (default: the working directory)
  --host <dir>       the web-host directory (default: resolved from the app root)
  --pack <dir>       the UI pack: also regenerate the lock and fail when the committed one is stale
  --only <step>      run one step: guards, tests or classifications
  --out <file>       with --only classifications: write the route classification file the runtime
                     route audit reads (--classifications); no guards or tests run
  --explain          map composed paths in findings back to the pack source files
  --json             print a stable JSON document instead of text
  -h, --help         print this help

Exit codes: 0 success, 1 a guard, test or integrity failure, 2 a usage error.
`

const TOOL = 'pv-verify'

const OPTIONS = {
  app: { type: 'string' },
  host: { type: 'string' },
  pack: { type: 'string' },
  only: { type: 'string' },
  out: { type: 'string' },
  explain: { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; strict: true }>>['values']

function explainLine(line: string, sources: Record<string, string>): string {
  return Object.entries(sources).reduce(
    (text, [dest, source]) => text.split(dest).join(`${dest} (pack source: ${source})`),
    line
  )
}

function guardLines(report: VerifyReport): string[] {
  const guards = report.guards
  if (guards === undefined) return []
  const passed = guards.outcomes.filter((outcome) => outcome.ok).length
  return [
    `pv-verify: guards: ${passed} passed, ${guards.outcomes.length - passed} failed`,
    ...guards.outcomes.map(
      (outcome) =>
        `  ${outcome.ok ? 'ok  ' : 'FAIL'} ${outcome.id} (${outcome.kind}, ${outcome.ms} ms)`
    ),
    ...guards.outcomes.flatMap((outcome) =>
      outcome.failures.map((line) => `    ${outcome.id}: ${line}`)
    ),
    ...guards.skipped.map((line) => `  ${line}`),
    ...guards.problems.map((line) => `  ${line}`),
  ]
}

function testLines(report: VerifyReport): string[] {
  const tests = report.tests
  if (tests === undefined) return []
  const failedNote = tests.failed > 0 ? `, ${tests.failed} failed` : ''
  return [
    `pv-verify: tests: ${tests.run} run, ${tests.excluded.length} excluded${failedNote}`,
    ...(tests.config === undefined ? [] : [`  config ${tests.config}`]),
    ...tests.excluded.map((test) => `  excluded ${test}`),
    ...tests.failures.map((line) => `    ${line}`),
    ...tests.problems.map((line) => `  ${line}`),
  ]
}

/** The human report: one section per step, warnings and entry counts last. */
export function formatReport(report: VerifyReport, explain: boolean): string {
  const lockNote = report.preflight.regenerated
    ? 'lock regenerated and equal'
    : 'lock present, pass --pack to also regenerate it'
  const lines = [
    report.preflight.ok ? `pv-verify: preflight ok (${lockNote})` : 'pv-verify: preflight FAILED',
    ...report.preflight.problems.map((line) => `  ${line}`),
    ...guardLines(report),
    ...testLines(report),
    ...report.warnings,
    `pv-verify: entries ${Object.entries(report.entries)
      .map(([key, count]) => `${key}=${count}`)
      .join(' ')}`,
    report.ok ? 'pv-verify: ok' : 'pv-verify: failed',
  ]
  return `${(explain ? lines.map((line) => explainLine(line, report.sources)) : lines).join('\n')}\n`
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** The guards or tests step (`--only` was validated by `outProblem`); classifications is not one. */
function stepOf(only: string | undefined): VerifyOptions['only'] {
  return only === 'guards' || only === 'tests' ? only : undefined
}

const STEPS = new Set(['guards', 'tests', 'classifications'])

/** A usage problem with `--only`/`--out`: `--out` belongs to the classifications step alone. */
function outProblem(only: string | undefined, out: string | undefined): string | null {
  if (only !== undefined && !STEPS.has(only)) {
    return `--only must be guards, tests or classifications, got "${only}"`
  }
  if (only === 'classifications') {
    return out === undefined
      ? '--only classifications needs --out <file>, the classification file to write'
      : null
  }
  return out === undefined ? null : '--out only applies to --only classifications'
}

interface Parsed {
  appRoot: string
  hostDir: string
  packRoot?: string
  only?: VerifyOptions['only']
  json: boolean
  explain: boolean
  /** Set for `--only classifications`: the absolute file to write. */
  classifyOut?: string
}

async function runExtract(parsed: Parsed & { classifyOut: string }, io: CliIo): Promise<number> {
  const { appRoot, hostDir, packRoot, classifyOut, json } = parsed
  const result = await extractClassifications({
    appRoot,
    hostDir,
    out: classifyOut,
    ...(packRoot === undefined ? {} : { packRoot }),
  })
  if (json) {
    io.out(`${JSON.stringify({ ok: result.ok, entries: result.entries })}\n`)
  } else if (result.ok) {
    io.out(`${TOOL}: classifications: ${result.entries} entries written\n`)
  }
  if (!result.ok) {
    const lines = result.problems.map((line) => TOOL + ': ' + line)
    io.err(lines.join('\n') + '\n')
  }
  return result.ok ? EXIT.ok : EXIT.failed
}

function parse(
  argv: readonly string[],
  io: CliIo,
  locate: (appRoot: string) => string
): Parsed | { exit: number } {
  const fail = (message: string): { exit: number } => ({
    exit: usageError(io, TOOL, message, USAGE),
  })
  let values: Values
  try {
    values = parseArgs({ args: [...argv], options: OPTIONS, strict: true }).values
  } catch (error) {
    return fail((error as Error).message)
  }
  if (values.help === true) {
    io.out(USAGE)
    return { exit: EXIT.ok }
  }
  const stepProblem = outProblem(values.only, values.out)
  if (stepProblem !== null) return fail(stepProblem)
  const appRoot = resolve(values.app ?? process.cwd())
  if (!isDirectory(appRoot)) return fail(`--app ${appRoot} is not a directory`)
  const hostDir = hostDirectory(values.host, appRoot, locate)
  if (hostDir === undefined) return fail(NO_HOST_MESSAGE)
  return {
    appRoot,
    hostDir,
    json: values.json === true,
    explain: values.explain === true,
    ...optionalFields(values),
  }
}

function optionalFields(values: Values): Partial<Parsed> {
  const packRoot = resolveOptional(values.pack)
  const only = stepOf(values.only)
  return {
    // Relative to the working directory, not to --app.
    ...(values.only === 'classifications' ? { classifyOut: resolve(values.out ?? '') } : {}),
    ...(packRoot === undefined ? {} : { packRoot }),
    ...(only === undefined ? {} : { only }),
  }
}

/** The CLI contract: 0 success, 1 a guard/test/integrity failure, 2 usage. */
export async function runVerifyCli(
  argv: readonly string[],
  io: CliIo,
  locate: (appRoot: string) => string = locateHost
): Promise<number> {
  const parsed = parse(argv, io, locate)
  if ('exit' in parsed) return parsed.exit
  const held = acquireRunLock(parsed.appRoot)
  if ('heldBy' in held) {
    io.err(
      `${TOOL}: another pv-verify (pid ${held.heldBy}) is already running on ${parsed.appRoot}\n`
    )
    return EXIT.failed
  }
  try {
    const { json, explain, classifyOut, ...options } = parsed
    if (classifyOut !== undefined) return await runExtract({ ...parsed, classifyOut }, io)
    const report = await verify(options)
    io.out(json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report, explain))
    return report.ok ? EXIT.ok : EXIT.failed
  } catch (error) {
    io.err(`${TOOL}: ${(error as Error).message}\n`)
    return EXIT.failed
  } finally {
    held.release()
  }
}

await runAsScript(TOOL, import.meta.url, runVerifyCli)
