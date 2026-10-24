// Story 68-26: the composed tree's `svelte-check` configuration. PV decides which of its tests are
// about a subject the pack displaced (`excludedPvTests`, recorded in the lock); the composed Vitest
// run already honors it through the web-host's `vitestConfig`. This writes the same list as a
// tsconfig that extends the app's own, so svelte-check checks exactly the files Vitest runs: the
// replacement tests, every retained PV test, generated route types and production sources.
import { dirname, isAbsolute, join, posix, relative } from 'node:path'
import type * as TypeScript from 'typescript'
import { requirePeer } from './peers.js'
import { manifestPathProblem, toPosix } from './paths.js'
import { lstatPath, pathExists } from './fs-access.js'
import { outProblem, preflight, writeJsonAtomically, type VerifyOptions } from './verify.js'

export interface TsconfigOptions {
  appRoot: string
  hostDir: string
  packRoot?: string
  /** Absolute path of the tsconfig to write. */
  out: string
}

export interface TsconfigResult {
  ok: boolean
  excluded: number
  problems: string[]
}

const APP_TSCONFIG = 'tsconfig.json'
// TypeScript's exclude wildcards are `*` and `?` only; `[`, `]` and `(` are literal (SvelteKit route dirs).
const GLOB = /[*?]/

function isRegularFile(path: string): boolean {
  try {
    return lstatPath(path).isFile()
  } catch {
    return false
  }
}

/**
 * Why a lock entry cannot be an exact test file, or null. An entry such as `src` or `src/lib` would
 * silently drop a whole directory from svelte-check, and a glob would widen the exclusion, so each
 * entry must be an existing regular `.test.ts` file of the composed app. This holds even when the
 * host publishes no test-subjects map (then nothing else cross-checks the list).
 */
function entryProblem(entry: string, appRoot: string): string | null {
  const reason =
    manifestPathProblem(entry) ??
    (GLOB.test(entry) ? 'contains a glob character' : null) ??
    (entry.endsWith('.test.ts') ? null : 'is not a .test.ts file') ??
    (isRegularFile(join(appRoot, entry)) ? null : 'is not an existing file of the composed app')
  return reason === null ? null : `invalid excludedPvTests entry "${entry}": ${reason}`
}

// A `configDir` template entry resolves against the config TypeScript reads last, so it stays as is.
const CONFIG_DIR = '$' + '{configDir}'
const TS_DEFAULT_EXCLUDE = ['node_modules', 'bower_components', 'jspm_packages']
// TypeScript: "No inputs were found in config file" (nothing to check yet is not our concern).
const NO_INPUTS = 18003

/**
 * The `exclude` the app's `tsconfig.json` effectively has, read by TypeScript itself through the whole
 * `extends` chain (the SvelteKit-generated `.svelte-kit/tsconfig.json` sets its own), rebased to the app
 * root. An extending config's `exclude` REPLACES the inherited one, so the generated file must repeat it.
 */
function baseExclude(appRoot: string): { exclude?: string[]; problem?: string } {
  const path = join(appRoot, APP_TSCONFIG)
  if (!pathExists(path)) {
    return { problem: `no ${APP_TSCONFIG} in the app root ${appRoot}; svelte-check needs it` }
  }
  const ts = requirePeer<typeof TypeScript>('typescript', appRoot)
  const unrecoverable: TypeScript.Diagnostic[] = []
  const parsed = ts.getParsedCommandLineOfConfigFile(
    path,
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => unrecoverable.push(d) }
  )
  const syntax = ts.readConfigFile(path, ts.sys.readFile).error
  const problems = [...unrecoverable, ...(parsed?.errors ?? []), ...(syntax ? [syntax] : [])]
    .filter((diagnostic) => diagnostic.code !== NO_INPUTS)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
  if (parsed === undefined || problems.length > 0) {
    return {
      problem: `${path} cannot be read by TypeScript (${problems.join('; ')}); run svelte-kit sync before pv-verify --only tsconfig, and keep ${APP_TSCONFIG} valid`,
    }
  }
  return { exclude: inheritedExclude(parsed, appRoot) }
}

function inheritedExclude(parsed: TypeScript.ParsedCommandLine, appRoot: string): string[] {
  const raw = parsed.raw as { exclude?: unknown } | undefined
  if (Array.isArray(raw?.exclude)) return raw.exclude.map(String)
  // TypeScript's own rule (no `exclude` anywhere in the chain): outDir and declarationDir REPLACE the defaults.
  const outputs = [parsed.options.outDir, parsed.options.declarationDir]
    .filter((dir): dir is string => dir !== undefined && dir !== '')
    .map((dir) => toPosix(relative(appRoot, dir)))
  return outputs.length > 0 ? outputs : TS_DEFAULT_EXCLUDE
}

/** `path` (relative to the app root) as seen from the generated file's directory. */
function anchored(out: string, appRoot: string, path: string): string {
  return toPosix(relative(dirname(out), join(appRoot, path)))
}

/**
 * Writes a tsconfig extending the app's `tsconfig.json` whose `exclude` is the app's own plus the
 * lock's `excludedPvTests`, exactly. The lock goes through the same preflight as `pv-verify` (present,
 * current, guard entries untampered, list equal to what the lock's own overrides imply), so a stale or
 * hand-edited list fails closed and nothing is written.
 */
export async function extractTsconfig(options: TsconfigOptions): Promise<TsconfigResult> {
  const failed = (problems: string[]): TsconfigResult => ({ ok: false, excluded: 0, problems })
  const checked = await preflight(options as VerifyOptions)
  if (checked.lock === undefined || checked.problems.length > 0) return failed(checked.problems)
  const excluded = [...checked.lock.excludedPvTests]
  const invalid = excluded
    .map((entry) => entryProblem(entry, options.appRoot))
    .filter((problem) => problem !== null)
  if (invalid.length > 0) return failed(invalid)
  const target = outProblem(options.out)
  if (target !== null) return failed([target])
  const base = baseExclude(options.appRoot)
  if (base.exclude === undefined) return failed([base.problem ?? `${APP_TSCONFIG} is unusable`])
  const config = {
    extends: `./${anchored(options.out, options.appRoot, APP_TSCONFIG)}`.replace('./..', '..'),
    exclude: [
      ...base.exclude.map((entry) =>
        isAbsolute(entry) || entry.startsWith(CONFIG_DIR)
          ? entry
          : anchored(options.out, options.appRoot, posix.normalize(entry))
      ),
      ...excluded.map((test) => anchored(options.out, options.appRoot, test)),
    ],
  }
  const writeProblem = writeJsonAtomically(options.out, config)
  if (writeProblem !== null) return failed([writeProblem])
  return { ok: true, excluded: excluded.length, problems: [] }
}
