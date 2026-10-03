import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type * as TypeScript from 'typescript'
import { manifestPathProblem } from './paths.js'
import { requirePeer } from './peers.js'
import { isExactVersion } from './versions.js'
import type { UiPackManifest } from './types.js'

const SHA256 = /^[0-9a-f]{64}$/
const KNOWN_KEYS = new Set([
  'host',
  'routes',
  'injections',
  'replacements',
  'hooks',
  'nav',
  'theme',
  'messages',
  'protectedPaths',
  'guards',
])

export interface ManifestValidation {
  manifest?: UiPackManifest
  problems: string[]
  notes: string[]
}

type Rec = Record<string, unknown>

function isRecord(value: unknown): value is Rec {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function optionalString(value: unknown, label: string, problems: string[]): void {
  if (value !== undefined && typeof value !== 'string') problems.push(`${label} must be a string`)
}

function checkHash(value: unknown, label: string, problems: string[]): void {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    problems.push(`${label} must be 64 lowercase hex characters`)
  }
}

function checkOverrides(value: unknown, problems: string[], notes: string[]): void {
  if (!Array.isArray(value)) {
    problems.push('routes.overrides must be an array')
    return
  }
  const seen = new Set<string>()
  value.forEach((entry: unknown, index) => {
    const label = `routes.overrides[${index}]`
    if (!isRecord(entry)) {
      problems.push(`${label} must be an object`)
      return
    }
    const path = entry.path
    if (typeof path !== 'string') {
      problems.push(`${label}.path must be a string`)
    } else {
      const problem = manifestPathProblem(path)
      if (problem !== null) problems.push(`${label}.path "${path}" ${problem}`)
      if (seen.has(path)) problems.push(`${label}.path "${path}" is declared twice`)
      seen.add(path)
      if (entry.story === undefined) notes.push(`override ${path} has no story`)
    }
    checkHash(entry.hostSha256, `${label}.hostSha256`, problems)
    optionalString(entry.story, `${label}.story`, problems)
  })
}

function checkRoutes(value: unknown, problems: string[], notes: string[]): void {
  if (!isRecord(value)) {
    problems.push('routes must be an object')
    return
  }
  if (value.overrides !== undefined) checkOverrides(value.overrides, problems, notes)
  if (value.remove !== undefined && !isStringArray(value.remove)) {
    problems.push('routes.remove must be an array of strings')
  }
}

function checkInjections(value: unknown, problems: string[]): void {
  if (!isRecord(value)) {
    problems.push('injections must be an object')
    return
  }
  for (const [name, list] of Object.entries(value)) {
    if (!Array.isArray(list)) {
      problems.push(`injections.${name} must be an array`)
      continue
    }
    const listed = new Set<string>()
    list.forEach((entry: unknown, index) => {
      const label = `injections.${name}[${index}]`
      if (!isRecord(entry)) {
        problems.push(`${label} must be an object`)
        return
      }
      if (typeof entry.component !== 'string') problems.push(`${label}.component must be a string`)
      else if (listed.size === listed.add(entry.component).size) {
        problems.push(`${label}.component: ${entry.component} is already listed at this point`)
      }
      if (entry.order !== undefined && !Number.isFinite(entry.order)) {
        problems.push(`${label}.order must be a finite number`)
      }
      optionalString(entry.load, `${label}.load`, problems)
      optionalString(entry.actions, `${label}.actions`, problems)
    })
  }
}

function checkReplacements(value: unknown, problems: string[], notes: string[]): void {
  if (!isRecord(value)) {
    problems.push('replacements must be an object')
    return
  }
  for (const [target, entry] of Object.entries(value)) {
    const label = `replacements.${target}`
    if (!isRecord(entry)) {
      problems.push(`${label} must be an object`)
      continue
    }
    if (typeof entry.with !== 'string') problems.push(`${label}.with must be a string`)
    checkHash(entry.hostSha256, `${label}.hostSha256`, problems)
    optionalString(entry.story, `${label}.story`, problems)
    if (entry.story === undefined) notes.push(`replacement ${target} has no story`)
  }
}

function checkHooks(value: unknown, problems: string[]): void {
  if (!isRecord(value)) {
    problems.push('hooks must be an object')
    return
  }
  for (const [key, entry] of Object.entries(value)) optionalString(entry, `hooks.${key}`, problems)
}

function checkProtectedPaths(value: unknown, problems: string[]): void {
  if (!isRecord(value)) {
    problems.push('protectedPaths must be an object')
    return
  }
  for (const [key, entry] of [
    ['add', value.add],
    ['remove', value.remove],
  ] as const) {
    if (entry !== undefined && !isStringArray(entry)) {
      problems.push(`protectedPaths.${key} must be an array of strings`)
    }
  }
}

function checkHost(value: unknown, problems: string[]): void {
  if (!isRecord(value) || typeof value.pvRelease !== 'string') {
    problems.push('host.pvRelease is required (an exact PV version, for example "1.4.0")')
    return
  }
  if (!isExactVersion(value.pvRelease)) {
    problems.push(`host.pvRelease "${value.pvRelease}" must be an exact version, not a range`)
  }
}

/** Structural validation only (types, known keys, hash and path shape). Never a policy check. */
export function validateManifest(raw: unknown): ManifestValidation {
  const problems: string[] = []
  const notes: string[] = []
  if (!isRecord(raw)) {
    return {
      problems: ['the manifest must be an object (export default defineUiPack({...}))'],
      notes,
    }
  }
  checkHost(raw.host, problems)
  if (raw.routes !== undefined) checkRoutes(raw.routes, problems, notes)
  if (raw.injections !== undefined) checkInjections(raw.injections, problems)
  if (raw.replacements !== undefined) checkReplacements(raw.replacements, problems, notes)
  if (raw.hooks !== undefined) checkHooks(raw.hooks, problems)
  if (raw.protectedPaths !== undefined) checkProtectedPaths(raw.protectedPaths, problems)
  optionalString(raw.nav, 'nav', problems)
  optionalString(raw.theme, 'theme', problems)
  optionalString(raw.messages, 'messages', problems)
  optionalString(raw.guards, 'guards', problems)
  for (const key of Object.keys(raw).filter((entry) => !KNOWN_KEYS.has(entry))) {
    notes.push(`unknown manifest key "${key}" ignored (a newer kit may give it meaning)`)
  }
  return problems.length > 0
    ? { problems, notes }
    : { manifest: raw as unknown as UiPackManifest, problems, notes }
}

export interface LoadOptions {
  /** Where `typescript` is resolved from (the app root). */
  resolveFrom: string
}

/** Loads CM's own trusted manifest. `.json` and `.js`/`.mjs` load natively. `.ts`/`.mts` are
 * transpiled with the app's own `typescript` (types stripped, nothing else changed) into a
 * temporary sibling `.mjs`, imported, and removed. This works on every Node the kit supports (20+)
 * with no extra dependency. Loading executes the manifest: it is trusted first-party code
 * (ADR 0007 invariant 0) and the kit adds no sandbox. */
export async function loadManifest(file: string, options: LoadOptions): Promise<unknown> {
  if (!existsSync(file)) throw new Error(`manifest not found: ${file}`)
  const extension = extname(file)
  if (extension === '.json') return JSON.parse(readFileSync(file, 'utf8')) as unknown
  if (extension === '.js' || extension === '.mjs') return defaultExport(file)
  if (extension === '.ts' || extension === '.mts') return loadTypeScript(file, options)
  throw new Error(
    `unsupported manifest extension "${extension}" (use .ts, .mts, .js, .mjs or .json)`
  )
}

async function defaultExport(file: string): Promise<unknown> {
  const loaded = (await import(
    `${pathToFileURL(file).href}?v=${randomBytes(4).toString('hex')}`
  )) as { default?: unknown }
  if (loaded.default === undefined) {
    throw new Error(`${file} has no default export (export default defineUiPack({...}))`)
  }
  return loaded.default
}

async function loadTypeScript(file: string, options: LoadOptions): Promise<unknown> {
  const ts = requirePeer<typeof TypeScript>('typescript', options.resolveFrom)
  const output = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: basename(file),
  })
  const temp = join(dirname(file), `.pv-manifest-${randomBytes(6).toString('hex')}.mjs`)
  writeFileSync(temp, output.outputText, { mode: 0o600 })
  try {
    return await defaultExport(temp)
  } finally {
    rmSync(temp, { force: true })
  }
}
