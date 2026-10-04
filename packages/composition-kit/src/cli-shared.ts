// Plumbing shared by the kit's two commands (`pv-compose`, `pv-verify`): the output channel, how the
// web-host directory is found, the usage-error exit and the run-as-a-script entry.
import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface CliIo {
  out: (text: string) => void
  err: (text: string) => void
}

/** The exit codes both commands share: 0 success, 1 an integrity/drift/guard failure, 2 usage. */
export const EXIT = { ok: 0, failed: 1, usage: 2 } as const

export function locateHost(appRoot: string): string {
  const require = createRequire(join(appRoot, 'package.json'))
  return dirname(require.resolve('@project-vault/web-host/package.json'))
}

/** The web-host directory: `--host`, else resolved from the app root through its own `exports`. */
export function hostDirectory(
  hostFlag: string | undefined,
  appRoot: string,
  locate: (appRoot: string) => string
): string | undefined {
  if (hostFlag !== undefined) return resolve(hostFlag)
  try {
    return locate(appRoot)
  } catch {
    return undefined
  }
}

export function resolveOptional(value: string | undefined): string | undefined {
  return value === undefined ? undefined : resolve(value)
}

/** Prints `message` and the usage text on stderr and returns the usage exit code. */
export function usageError(io: CliIo, tool: string, message: string, usage: string): number {
  io.err(`${tool}: ${message}\n\n${usage}`)
  return EXIT.usage
}

export const NO_HOST_MESSAGE =
  'cannot locate @project-vault/web-host from the app root; install it or pass --host <dir>'

function realOrSelf(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Whether the module at `moduleUrl` is the process entry `argv1`. Node resolves symlinks for
 * `import.meta.url` but leaves `argv[1]` as typed, so a bin launched through `node_modules/.bin` (or a
 * symlinked package directory, as pnpm creates) differs from it as a URL. Compares real filesystem
 * paths. A missing `argv1` is never the entry; an `argv1` that cannot be resolved is compared as the
 * absolute path it names.
 */
export function isEntryPoint(moduleUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined || argv1 === '') return false
  const modulePath = realOrSelf(fileURLToPath(moduleUrl))
  return realOrSelf(resolve(argv1)) === modulePath
}

/** Runs `main` with the process streams when the file is the entry point (the `bin` case). */
export async function runAsScript(
  tool: string,
  moduleUrl: string,
  main: (argv: string[], io: CliIo) => Promise<number>
): Promise<void> {
  if (!isEntryPoint(moduleUrl, process.argv[1])) return
  try {
    process.exitCode = await main(process.argv.slice(2), {
      out: (text) => process.stdout.write(text),
      err: (text) => process.stderr.write(text),
    })
  } catch (error: unknown) {
    process.stderr.write(`${tool}: ${String(error)}\n`)
    process.exitCode = EXIT.failed
  }
}
