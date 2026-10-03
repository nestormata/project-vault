// Story 68.9: running vitest as a child process for `pv-verify`. The kit never imports vitest: it
// finds the app's own installation, writes a small config file under `<app>/.pv-compose/` and reads
// vitest's JSON report back. The child environment is built here, so a variable meant for one step
// (the guards' scan root) can never reach another (CM's own tests) or the caller's own process.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

export interface VitestAssertion {
  fullName: string
  status: string
  failureMessages?: string[]
}

export interface VitestSuite {
  name: string
  status: string
  startTime?: number
  endTime?: number
  message?: string
  assertionResults: VitestAssertion[]
}

export interface VitestReport {
  numTotalTests: number
  numPassedTests: number
  numFailedTests: number
  testResults: VitestSuite[]
}

/** The app's own vitest entry point (`vitest.mjs`), resolved from the app root. */
export function vitestBin(appRoot: string): string | null {
  try {
    const require = createRequire(join(appRoot, 'package.json'))
    const manifest = require.resolve('vitest/package.json')
    const { bin } = JSON.parse(readFileSync(manifest, 'utf8')) as {
      bin?: string | Record<string, string>
    }
    const entry = typeof bin === 'string' ? bin : (bin?.vitest ?? 'vitest.mjs')
    return join(dirname(manifest), entry)
  } catch {
    return null
  }
}

export interface RunInput {
  bin: string
  /** Where the child runs (a vitest `--root`). */
  root: string
  config: string
  reportFile: string
  /** Variables added to the child's environment. */
  extraEnv?: Record<string, string>
  /** Variables removed from the child's environment. */
  withoutEnv?: readonly string[]
}

export interface RunResult {
  status: number | null
  report: VitestReport | null
  /** The first lines of stderr, for a crash that wrote no report. */
  stderrTail: string
}

function childEnv(input: RunInput): NodeJS.ProcessEnv {
  const dropped = new Set(input.withoutEnv ?? [])
  return Object.fromEntries(
    Object.entries({ ...process.env, ...input.extraEnv }).filter(([name]) => !dropped.has(name))
  )
}

function readReport(file: string): VitestReport | null {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as VitestReport
  } catch {
    return null
  }
}

/** `vitest run` with the JSON reporter, never watching, no coverage gate. */
export function runVitest(input: RunInput): RunResult {
  const child = spawnSync(
    process.execPath,
    [
      input.bin,
      'run',
      '--root',
      input.root,
      '--config',
      input.config,
      '--reporter=json',
      `--outputFile=${input.reportFile}`,
    ],
    { cwd: input.root, env: childEnv(input), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  )
  return {
    status: child.status,
    report: readReport(input.reportFile),
    stderrTail: child.stderr.split('\n').filter(Boolean).slice(0, 12).join('\n'),
  }
}

const MAX_FAILURE_LINES = 25
const STACK_LINE = /^\s*(?:at |❯)/

/** A failure message without its stack: the assertion text and the diff that names the findings,
 * capped so a long diff cannot flood a CI summary. */
export function failureHead(message: string | undefined): string {
  const lines = (message ?? '').split('\n')
  const end = lines.findIndex((line) => STACK_LINE.test(line))
  return lines
    .slice(0, end === -1 ? lines.length : end)
    .slice(0, MAX_FAILURE_LINES)
    .map((line) => line.trimEnd())
    .join('\n      ')
    .trim()
    .slice(0, 2000)
}

/** One line per failed assertion of a suite, or its load error when it never ran. */
export function suiteFailures(suite: VitestSuite): string[] {
  const failed = suite.assertionResults.filter((assertion) => assertion.status === 'failed')
  if (failed.length === 0) {
    return suite.status === 'failed' ? [`suite failed to run: ${failureHead(suite.message)}`] : []
  }
  return failed.map(
    (assertion) => `${assertion.fullName}: ${failureHead(assertion.failureMessages?.[0])}`
  )
}
