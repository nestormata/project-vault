/**
 * Story 43.9 (typescript:S4036) — resolve the executables that root `scripts/` spawn without ever
 * consulting `$PATH`.
 *
 * - System tools (`git`, `docker`, `bash`, `openssl`, `find`) are looked up in a fixed list of root-owned
 *   directories. A missing tool fails loudly; there is deliberately no fallback to the bare name, because that
 *   would reintroduce the PATH lookup.
 * - Workspace-local tools (`tsc`, `ncc`) are resolved from the consuming package's own
 *   `node_modules` with `require.resolve`, so callers can run them under `process.execPath`
 *   instead of shelling out to `pnpm`.
 */
import { execFileSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** Root-owned system binary directories, searched in order. Never user-writable locations. */
export const TRUSTED_EXECUTABLE_DIRS: readonly string[] = ['/usr/bin', '/usr/local/bin', '/bin']

export type TrustedExecutable = 'git' | 'docker' | 'bash' | 'openssl' | 'find' | 'shellcheck'

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** `a`, `a or b`, `a, b or c` */
function humanList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`
}

/**
 * The absolute path of `name` in the first of `dirs` where it is an executable file.
 * Throws `<name> not found in <dirs>` when none has it.
 */
export function resolveTrustedExecutable(
  name: TrustedExecutable,
  dirs: readonly string[] = TRUSTED_EXECUTABLE_DIRS,
  isExecutable: (path: string) => boolean = isExecutableFile
): string {
  for (const dir of dirs) {
    const candidate = join(dir, name)
    if (isExecutable(candidate)) return candidate
  }
  throw new Error(`${name} not found in ${humanList(dirs)}`)
}

/**
 * Runs the trusted `git` in `cwd` and returns its stdout. stderr is captured (surfacing on the
 * thrown error), never inherited. Node's default 1MB maxBuffer would eventually overflow on
 * whole-history commands such as `git log --merges` over this repo and crash a check outright
 * with ERR_CHILD_PROCESS_STDOUT_MAXBUFFER instead of reporting; 64MB is generous headroom.
 */
export function trustedGit(cwd: string, args: string[]): string {
  return execFileSync(resolveTrustedExecutable('git'), args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
}

type PackageJson = { bin?: string | Record<string, string>; name?: string }

/**
 * The absolute path of package `pkg`'s `binName` executable script, resolved from `fromDir`'s
 * `package.json` so the version pinned by that workspace package is the one used. Run the result
 * with `process.execPath`.
 */
export function resolveBin(pkg: string, binName: string, fromDir: string): string {
  const requireFromPackage = createRequire(join(fromDir, 'package.json'))
  let manifestPath: string
  let manifest: PackageJson
  try {
    // Module resolution both locates and loads the manifest, so the file read is always the one
    // Node's resolver picked for `pkg` (never an arbitrary caller-built path).
    manifestPath = requireFromPackage.resolve(`${pkg}/package.json`)
    manifest = requireFromPackage(manifestPath) as PackageJson
  } catch (error) {
    throw new Error(`${pkg} is not resolvable from ${fromDir}: ${(error as Error).message}`)
  }
  const bins = new Map(
    typeof manifest.bin === 'string' ? [[pkg, manifest.bin]] : Object.entries(manifest.bin ?? {})
  )
  const relative = bins.get(binName)
  if (!relative) throw new Error(`${pkg} has no bin entry named ${binName}`)
  return join(dirname(manifestPath), relative)
}
