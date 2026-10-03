#!/usr/bin/env node
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
import { compose, type RunOptions } from './compose.js'

const USAGE = `Usage: pv-compose --pack <dir> [options]

Composes a UI pack onto @project-vault/web-host in the app root, writes composition.lock.json.

  --pack <dir>             the UI pack directory (required)
  --app <dir>              the app root to compose into (default: the working directory)
  --manifest <file>        the pack manifest (default: <pack>/pv-ui.manifest.ts)
  --host <dir>             the web-host directory (default: resolved from the app root)
  --lock <file>            the lock path (default: <app>/composition.lock.json)
  --module-pack <dir>      the module pack package root: its extension-api is checked against the tuple, and its
                           entry is imported to record apiRoutes.override in the lock (runs its top-level code)
  --check                  fail when the committed lock is not current (writes nothing)
  --dry-run                print the plan summary and write nothing
  --accept-host <path>     accept the current web-host hash of a declared override or replacement (repeatable)
  --previous-host <dir>    a previous web-host directory, for the true old-to-new PV diff
  --verbose                also print each derived protected (app) route
  -h, --help               print this help

Exit codes: 0 success, 1 an integrity, drift, compatibility or --check failure, 2 a usage error.
`

export type { CliIo }

const TOOL = 'pv-compose'

const OPTIONS = {
  pack: { type: 'string' },
  app: { type: 'string' },
  manifest: { type: 'string' },
  host: { type: 'string' },
  lock: { type: 'string' },
  'module-pack': { type: 'string' },
  check: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  'accept-host': { type: 'string', multiple: true },
  'previous-host': { type: 'string' },
  verbose: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; strict: true }>>['values']

/** The optional flags, each present in the result only when given. */
function optionalOptions(values: Values): Partial<RunOptions> {
  const path = resolveOptional
  const entries: [string, unknown][] = [
    ['manifestPath', path(values.manifest)],
    ['lockPath', path(values.lock)],
    ['modulePack', path(values['module-pack'])],
    ['previousHost', path(values['previous-host'])],
    ['acceptHost', values['accept-host']],
    ['check', values.check === true ? true : undefined],
    ['dryRun', values['dry-run'] === true ? true : undefined],
    ['verbose', values.verbose === true ? true : undefined],
  ]
  return Object.fromEntries(
    entries.filter(([, value]) => value !== undefined)
  ) as Partial<RunOptions>
}

function runOptions(
  values: Values,
  log: (line: string) => void,
  locate: (appRoot: string) => string
): RunOptions | string {
  if (values.pack === undefined) return 'missing required option --pack <dir>'
  const appRoot = resolve(values.app ?? process.cwd())
  const hostDir = hostDirectory(values.host, appRoot, locate)
  if (hostDir === undefined) return NO_HOST_MESSAGE
  return { appRoot, packRoot: resolve(values.pack), hostDir, log, ...optionalOptions(values) }
}

/** The CLI contract: 0 success, 1 integrity/drift/compatibility/--check failure, 2 usage error.
 * Every problem found is printed in one run, followed by a one-line count. */
export async function runCli(
  argv: readonly string[],
  io: CliIo,
  locate: (appRoot: string) => string = locateHost
): Promise<number> {
  let values: Values
  try {
    values = parseArgs({ args: [...argv], options: OPTIONS, strict: true }).values
  } catch (error) {
    return usageError(io, TOOL, (error as Error).message, USAGE)
  }
  if (values.help === true) {
    io.out(USAGE)
    return EXIT.ok
  }
  const options = runOptions(values, (line) => io.out(`${line}\n`), locate)
  if (typeof options === 'string') {
    return usageError(io, TOOL, options, USAGE)
  }
  try {
    const result = await compose(options)
    for (const message of result.messages) io.err(`${message}\n`)
    if (!result.ok) {
      const count = result.plan.problems.length
      io.err(`pv-compose: failed (${count} problem${count === 1 ? '' : 's'})\n`)
      return EXIT.failed
    }
    return EXIT.ok
  } catch (error) {
    io.err(`pv-compose: ${(error as Error).message}\n`)
    return EXIT.failed
  }
}

await runAsScript(TOOL, import.meta.url, runCli)
