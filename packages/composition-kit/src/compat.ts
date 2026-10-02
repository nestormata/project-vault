import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CompatibilityTuple } from './types.js'
import { compareCodeUnits } from './paths.js'
import { isExactVersion } from './versions.js'

const EXTENSION_API = '@project-vault/extension-api'
const COMPOSITION_KIT = '@project-vault/composition-kit'

export interface CheckResult {
  problems: string[]
  notes: string[]
}

/** The version actually installed for `name`, found by Node's own node_modules walk from `fromDir`
 * (never a declared range). Reads package.json directly, so a package whose `exports` hides it
 * still resolves. */
export function resolveInstalledVersion(fromDir: string, name: string): string | undefined {
  let dir = fromDir
  for (;;) {
    const candidate = join(dir, 'node_modules', name, 'package.json')
    if (existsSync(candidate)) {
      const version = (JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown }).version
      return typeof version === 'string' ? version : undefined
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function exactVersionProblem(value: unknown, field: string): string[] {
  return isExactVersion(value)
    ? []
    : [
        `manifests/compatibility.json: ${field} must be an exact version string, found ${JSON.stringify(value ?? null)}`,
      ]
}

/** The compatibility manifest must itself be complete: a null or missing field names itself. */
export function validateTuple(raw: unknown): { tuple?: CompatibilityTuple; problems: string[] } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { problems: ['manifests/compatibility.json must be a JSON object'] }
  }
  const record = new Map(Object.entries(raw as Record<string, unknown>))
  const toolchain = new Map(
    Object.entries((record.get('toolchain') ?? {}) as Record<string, unknown>)
  )
  const problems = [
    ...exactVersionProblem(record.get('pvRelease'), 'pvRelease'),
    ...exactVersionProblem(record.get('extensionApiVersion'), 'extensionApiVersion'),
    ...exactVersionProblem(record.get('kitVersion'), 'kitVersion'),
    ...['kit', 'svelte', 'typescript', 'vite'].flatMap((key) =>
      exactVersionProblem(toolchain.get(key), `toolchain.${key}`)
    ),
  ]
  return problems.length > 0 ? { problems } : { tuple: raw as CompatibilityTuple, problems }
}

export interface CompatibilityInput {
  appRoot: string
  /** How the app is named in messages (for example `apps/pv-composed`). */
  appLabel: string
  tuple: CompatibilityTuple
  /** The manifest's `host.pvRelease`. */
  packPvRelease: string
  modulePack?: string
}

function mismatch(
  name: string,
  resolved: string | undefined,
  where: string,
  built: string
): string[] {
  if (resolved === built) return []
  const state = resolved === undefined ? 'is not installed' : `resolved ${resolved}`
  return [`Compatibility mismatch: ${name} ${state} (${where}), web-host was built with ${built}.`]
}

/** Design section 11: every resolved version against the tuple, all reported in one run. */
export function checkCompatibility(input: CompatibilityInput): CheckResult {
  const { appRoot, appLabel, tuple } = input
  const resolved = (name: string): string | undefined => resolveInstalledVersion(appRoot, name)
  const problems = [
    ...mismatch('@sveltejs/kit', resolved('@sveltejs/kit'), appLabel, tuple.toolchain.kit),
    ...mismatch('svelte', resolved('svelte'), appLabel, tuple.toolchain.svelte),
    ...mismatch('vite', resolved('vite'), appLabel, tuple.toolchain.vite),
    ...mismatch('typescript', resolved('typescript'), appLabel, tuple.toolchain.typescript),
    ...mismatch(COMPOSITION_KIT, resolved(COMPOSITION_KIT), appLabel, tuple.kitVersion),
  ]
  if (input.packPvRelease !== tuple.pvRelease) {
    problems.push(
      `Compatibility mismatch: manifest targets PV ${input.packPvRelease} but web-host is ${tuple.pvRelease}; run the upgrade flow.`
    )
  }
  const notes: string[] = []
  if (input.modulePack === undefined) {
    notes.push('extension-api version not checked: no --module-pack given')
  } else {
    problems.push(
      ...mismatch(
        EXTENSION_API,
        resolveInstalledVersion(input.modulePack, EXTENSION_API),
        `module pack ${input.modulePack}`,
        tuple.extensionApiVersion
      )
    )
  }
  return { problems, notes }
}

/** Every web-host runtime dependency must be a runtime dependency of the composed app, installed
 * at the identical version (adapter-node externalizes only `dependencies`). */
export function checkRuntimeDependencies(
  appRoot: string,
  hostDependencies: Record<string, string>
): string[] {
  const appManifest = JSON.parse(readFileSync(join(appRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  const appDependencies = new Map(Object.entries(appManifest.dependencies ?? {}))
  const problems: string[] = []
  for (const [name, required] of Object.entries(hostDependencies)) {
    if (!appDependencies.has(name)) {
      problems.push(
        `Runtime dependency ${name} must be a runtime dependency of the composed app (adapter-node externalizes only dependencies).`
      )
      continue
    }
    const installed = resolveInstalledVersion(appRoot, name)
    if (installed !== required) {
      problems.push(
        `Runtime dependency ${name} resolved ${installed ?? 'nothing'}, web-host requires ${required}.`
      )
    }
  }
  return problems.sort(compareCodeUnits)
}
