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
import { acquireRunLock, verify, type VerifyOptions, type VerifyReport } from './verify.js'

const USAGE = `Usage: pv-verify [options]

Runs PV's web guards and PV's unit tests over a composed app, in this order, and reports every
finding in one run: preflight (the lock is current), guards, tests. There is no flag that skips,
disables or ignores a step or a guard.

  --app <dir>        the composed app root (default: the working directory)
  --host <dir>       the web-host directory (default: resolved from the app root)
  --pack <dir>       the UI pack: also regenerate the lock and fail when the committed one is stale
  --only <step>      run one step: guards or tests
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

function stepOf(only: string | undefined): VerifyOptions['only'] | 'invalid' {
  if (only === undefined) return undefined
  return only === 'guards' || only === 'tests' ? only : 'invalid'
}

interface Parsed {
  appRoot: string
  hostDir: string
  packRoot?: string
  only?: VerifyOptions['only']
  json: boolean
  explain: boolean
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
  if (values.only === 'classifications') {
    return fail(
      'the route classification step is delivered with story 68-14 (the audit file schema it feeds); it is not available yet'
    )
  }
  const only = stepOf(values.only)
  if (only === 'invalid')
    return fail(`--only must be guards or tests, got "${String(values.only)}"`)
  const appRoot = resolve(values.app ?? process.cwd())
  if (!isDirectory(appRoot)) return fail(`--app ${appRoot} is not a directory`)
  const hostDir = hostDirectory(values.host, appRoot, locate)
  if (hostDir === undefined) return fail(NO_HOST_MESSAGE)
  const packRoot = resolveOptional(values.pack)
  return {
    appRoot,
    hostDir,
    json: values.json === true,
    explain: values.explain === true,
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
    const { json, explain, ...options } = parsed
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
