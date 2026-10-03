#!/usr/bin/env node
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { compose, type RunOptions } from './compose.js'

const USAGE = `Usage: pv-compose --pack <dir> [options]

Composes a UI pack onto @project-vault/web-host in the app root, writes composition.lock.json.

  --pack <dir>             the UI pack directory (required)
  --app <dir>              the app root to compose into (default: the working directory)
  --manifest <file>        the pack manifest (default: <pack>/pv-ui.manifest.ts)
  --host <dir>             the web-host directory (default: resolved from the app root)
  --lock <file>            the lock path (default: <app>/composition.lock.json)
  --module-pack <dir>      a directory that resolves @project-vault/extension-api (checked against the tuple)
  --check                  fail when the committed lock is not current (writes nothing)
  --dry-run                print the plan summary and write nothing
  --accept-host <path>     accept the current web-host hash of a declared override or replacement (repeatable)
  --previous-host <dir>    a previous web-host directory, for the true old-to-new PV diff
  --verbose                also print each derived protected (app) route
  -h, --help               print this help

Exit codes: 0 success, 1 an integrity, drift, compatibility or --check failure, 2 a usage error.
`

export interface CliIo {
  out: (text: string) => void
  err: (text: string) => void
}

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

function locateHost(appRoot: string): string {
  const require = createRequire(join(appRoot, 'package.json'))
  return dirname(require.resolve('@project-vault/web-host/package.json'))
}

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; strict: true }>>['values']

/** The web-host directory: `--host`, else resolved from the app root through its own `exports`. */
function hostDirectory(
  values: Values,
  appRoot: string,
  locate: (appRoot: string) => string
): string | undefined {
  if (values.host !== undefined) return resolve(values.host)
  try {
    return locate(appRoot)
  } catch {
    return undefined
  }
}

/** The optional flags, each present in the result only when given. */
function optionalOptions(values: Values): Partial<RunOptions> {
  const path = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : resolve(value)
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
  const hostDir = hostDirectory(values, appRoot, locate)
  if (hostDir === undefined) {
    return 'cannot locate @project-vault/web-host from the app root; install it or pass --host <dir>'
  }
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
    io.err(`pv-compose: ${(error as Error).message}\n\n${USAGE}`)
    return 2
  }
  if (values.help === true) {
    io.out(USAGE)
    return 0
  }
  const options = runOptions(values, (line) => io.out(`${line}\n`), locate)
  if (typeof options === 'string') {
    io.err(`pv-compose: ${options}\n\n${USAGE}`)
    return 2
  }
  try {
    const result = await compose(options)
    for (const message of result.messages) io.err(`${message}\n`)
    if (!result.ok) {
      const count = result.plan.problems.length
      io.err(`pv-compose: failed (${count} problem${count === 1 ? '' : 's'})\n`)
      return 1
    }
    return 0
  } catch (error) {
    io.err(`pv-compose: ${(error as Error).message}\n`)
    return 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = await runCli(process.argv.slice(2), {
      out: (text) => process.stdout.write(text),
      err: (text) => process.stderr.write(text),
    })
  } catch (error: unknown) {
    process.stderr.write(`pv-compose: ${String(error)}\n`)
    process.exitCode = 1
  }
}
