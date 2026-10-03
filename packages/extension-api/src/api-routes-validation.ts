import {
  assertOnlyKeys as assertKnownKeys,
  fail,
  isRecord,
  validateApiRouteSecurity,
} from './api-routes-security-validation.js'
import { API_ROUTE_HOOK_PHASES, API_ROUTE_METHODS } from './hooks/api-routes.js'
import type {
  ApiRouteHookPhase,
  ApiRouteImplementation,
  ApiRoutesAppDeclaration,
  ApiRoutesDeclaration,
  ApiRoutesHooks,
  AppBehaviourHooks,
} from './hooks/api-routes.js'

/**
 * Story 68.8 AC-2 — `apiRoutes` validation. INTEGRITY ONLY: shapes, known keys, well-formed
 * methods and URLs, no duplicate keys, a handler behind every declaration. It never consults
 * `capabilities`, `anonymousRoutePaths`, `redirectOrigins`, a URL prefix or a count cap (M7 may
 * not be narrowed). Every failure uses the existing `invalid-manifest-field` reason.
 */

export const MAX_API_ROUTE_URL_LENGTH = 2048

const TOP_LEVEL_KEYS = ['add', 'override', 'app']
const APP_KEYS = ['hooks', 'errorHandler', 'notFoundHandler']
const ADD_KEYS = ['method', 'url', 'options']
const ADD_OPTION_KEYS = ['security', 'bodyLimit', 'schema', 'hooks']
const OVERRIDE_KEYS = ['method', 'url', 'mode', 'schema', 'hooks', 'replaceSecurity', 'security']
const OVERRIDE_HOOK_KEYS = ['prepend', 'append']
const METHOD_LIST = API_ROUTE_METHODS.join(', ')
const PHASE_LIST = API_ROUTE_HOOK_PHASES.join(', ')

type UnknownRecord = Record<string, unknown>

function assertRecord(value: unknown, path: string): UnknownRecord {
  if (!isRecord(value)) fail(`${path} must be an object`)
  return value
}

function assertArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(`${path} must be an array`)
  return value
}

function hasForbiddenUrlCharacter(url: string): boolean {
  for (const character of url) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x20 || code === 0x7f || character === '?' || character === '#') return true
    if (/\s/u.test(character)) return true
  }
  return false
}

function assertUrl(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(`${path} must be a string`)
  if (!value.startsWith('/')) fail(`${path} must start with /`)
  if (value.length > MAX_API_ROUTE_URL_LENGTH) {
    fail(`${path} must be at most ${MAX_API_ROUTE_URL_LENGTH} characters`)
  }
  if (hasForbiddenUrlCharacter(value)) {
    fail(`${path} must not contain whitespace, control characters, ? or #`)
  }
  return value
}

function withoutTrailingSlash(url: string): string {
  return url.length > 1 && url.endsWith('/') ? url.slice(0, -1) : url
}

function assertMethod(value: unknown, path: string): string {
  if (typeof value !== 'string' || !(API_ROUTE_METHODS as readonly string[]).includes(value)) {
    fail(`${path} must be one of ${METHOD_LIST}`)
  }
  return value
}

function assertPhases(value: unknown, path: string): void {
  assertArray(value, path).forEach((phase, index) => {
    if (
      typeof phase !== 'string' ||
      !(API_ROUTE_HOOK_PHASES as readonly string[]).includes(phase)
    ) {
      fail(`${path}[${index}] must be one of ${PHASE_LIST}`)
    }
  })
}

function validateAddOptions(value: unknown, path: string): void {
  if (value === undefined) return
  const options = assertRecord(value, path)
  assertKnownKeys(options, ADD_OPTION_KEYS, path)
  validateApiRouteSecurity(options.security, `${path}.security`)
  if (options.schema !== undefined && typeof options.schema !== 'boolean') {
    fail(`${path}.schema must be a boolean`)
  }
  const bodyLimit = options.bodyLimit
  if (bodyLimit !== undefined && !(Number.isInteger(bodyLimit) && (bodyLimit as number) > 0)) {
    fail(`${path}.bodyLimit must be a positive integer`)
  }
  if (options.hooks !== undefined) assertPhases(options.hooks, `${path}.hooks`)
}

function validateOverrideHooks(value: unknown, path: string): void {
  if (value === undefined) return
  const hooks = assertRecord(value, path)
  assertKnownKeys(hooks, OVERRIDE_HOOK_KEYS, path)
  for (const [position, phases] of Object.entries(hooks)) {
    if (phases !== undefined) assertPhases(phases, `${path}.${position}`)
  }
}

function validateOverrideFields(entry: UnknownRecord, path: string): void {
  if (entry.mode !== 'replace' && entry.mode !== 'wrap') {
    fail(`${path}.mode must be 'replace' or 'wrap'`)
  }
  if (entry.schema !== undefined && entry.schema !== 'extend' && entry.schema !== 'replace') {
    fail(`${path}.schema must be 'extend' or 'replace'`)
  }
  validateOverrideHooks(entry.hooks, `${path}.hooks`)
  if (entry.replaceSecurity !== undefined && typeof entry.replaceSecurity !== 'boolean') {
    fail(`${path}.replaceSecurity must be a boolean`)
  }
  validateApiRouteSecurity(entry.security, `${path}.security`)
  if (entry.security !== undefined && entry.replaceSecurity !== true) {
    fail(`${path}: security is only honoured with replaceSecurity: true`)
  }
}

function assertWrapOrReplace(value: unknown, path: string): void {
  if (value !== undefined && value !== 'wrap' && value !== 'replace') {
    fail(`${path} must be 'wrap' or 'replace'`)
  }
}

/** Story 68.14: `apiRoutes.app`. Integrity only: known keys, closed phase list, wrap/replace. */
function validateAppShape(value: unknown): void {
  if (value === undefined) return
  const app = assertRecord(value, 'apiRoutes.app')
  assertKnownKeys(app, APP_KEYS, 'apiRoutes.app')
  validateOverrideHooks(app.hooks, 'apiRoutes.app.hooks')
  assertWrapOrReplace(app.errorHandler, 'apiRoutes.app.errorHandler')
  assertWrapOrReplace(app.notFoundHandler, 'apiRoutes.app.notFoundHandler')
}

function validateEntries(list: unknown, listName: 'add' | 'override', seen: Set<string>): void {
  if (list === undefined) return
  const path = `apiRoutes.${listName}`
  assertArray(list, path).forEach((rawEntry, index) => {
    const entryPath = `${path}[${index}]`
    const entry = assertRecord(rawEntry, entryPath)
    assertKnownKeys(entry, listName === 'add' ? ADD_KEYS : OVERRIDE_KEYS, entryPath)
    const method = assertMethod(entry.method, `${entryPath}.method`)
    const url = assertUrl(entry.url, `${entryPath}.url`)
    if (listName === 'add') validateAddOptions(entry.options, `${entryPath}.options`)
    else validateOverrideFields(entry, entryPath)
    // The host serves `/x` and `/x/` as one route (`ignoreTrailingSlash`), so they are one key.
    const key = `${method} ${withoutTrailingSlash(url)}`
    if (seen.has(key)) fail(`${entryPath} duplicates ${key}`)
    seen.add(key)
  })
}

/** AC-2 (a)-(f): the pre-`hooksFactory()` shape check. Receives only the `apiRoutes` value. */
export function validateApiRoutesShape(apiRoutes: unknown): void {
  if (apiRoutes === undefined) return
  const declaration = assertRecord(apiRoutes, 'apiRoutes')
  assertKnownKeys(declaration, TOP_LEVEL_KEYS, 'apiRoutes')
  const seen = new Set<string>()
  validateEntries(declaration.add, 'add', seen)
  validateEntries(declaration.override, 'override', seen)
  validateAppShape(declaration.app)
}

type DeclaredEntry = { key: string; schema: boolean; phases: ApiRouteHookPhase[] }

function declaredEntries(declaration: ApiRoutesDeclaration): DeclaredEntry[] {
  const added = (declaration.add ?? []).map((entry) => ({
    key: `${entry.method} ${entry.url}`,
    schema: entry.options?.schema === true,
    phases: entry.options?.hooks ?? [],
  }))
  const overridden = (declaration.override ?? []).map((entry) => ({
    key: `${entry.method} ${entry.url}`,
    schema: entry.schema !== undefined,
    phases: [...(entry.hooks?.prepend ?? []), ...(entry.hooks?.append ?? [])],
  }))
  return [...added, ...overridden]
}

function hasHookFunction(
  implementation: ApiRouteImplementation | AppBehaviourHooks,
  phase: ApiRouteHookPhase
): boolean {
  const value = new Map(Object.entries(implementation.hooks ?? {})).get(phase)
  const functions = Array.isArray(value) ? value : [value]
  return functions.length > 0 && functions.every((fn) => typeof fn === 'function')
}

function assertImplementation(
  entry: DeclaredEntry,
  implementation: ApiRouteImplementation | undefined
): void {
  if (!implementation || typeof implementation.handler !== 'function') {
    fail(`apiRoutes entry "${entry.key}" has no callable handler in hooks.apiRoutes.routes`)
  }
  if (entry.schema && implementation.schema === undefined) {
    fail(
      `apiRoutes entry "${entry.key}" declares a schema but hooks.apiRoutes.routes has no schema for it`
    )
  }
  const missingPhase = entry.phases.find((phase) => !hasHookFunction(implementation, phase))
  if (missingPhase !== undefined) {
    fail(
      `apiRoutes entry "${entry.key}" declares a ${missingPhase} hook but hooks.apiRoutes.routes has no function for it`
    )
  }
}

/**
 * AC-2 (g): the post-`hooksFactory()` check. Every declared key has a callable handler, a declared
 * schema has a value and a declared hook phase has a function. An implementation with no
 * declaration only warns.
 */
export function assertApiRouteImplementations(
  apiRoutes: ApiRoutesDeclaration | undefined,
  hooks: ApiRoutesHooks | undefined,
  warn: (message: string) => void
): void {
  const routes = new Map<string, ApiRouteImplementation | undefined>(
    Object.entries(hooks?.routes ?? {})
  )
  const entries = apiRoutes ? declaredEntries(apiRoutes) : []
  for (const entry of entries) {
    assertImplementation(entry, routes.get(entry.key))
  }
  const declaredKeys = new Set(entries.map((entry) => entry.key))
  for (const key of [...routes.keys()].sort((left, right) => left.localeCompare(right))) {
    if (!declaredKeys.has(key)) {
      warn(`hooks.apiRoutes.routes has an implementation for undeclared key "${key}"`)
    }
  }
}

function article(word: string): string {
  return /^[aeiou]/u.test(word) ? 'an' : 'a'
}

function assertAppFunction(declared: unknown, implemented: unknown, name: string): void {
  if (declared === undefined || typeof implemented === 'function') return
  fail(
    `apiRoutes.app declares ${article(name)} ${name} but hooks.apiRoutes.app has no function for it`
  )
}

function declaredAppPhases(app: ApiRoutesAppDeclaration): ApiRouteHookPhase[] {
  return [...(app.hooks?.prepend ?? []), ...(app.hooks?.append ?? [])]
}

function warnUndeclaredApp(
  app: ApiRoutesAppDeclaration,
  implemented: AppBehaviourHooks,
  warn: (message: string) => void
): void {
  const handlers = [
    ['errorHandler', app.errorHandler, implemented.errorHandler],
    ['notFoundHandler', app.notFoundHandler, implemented.notFoundHandler],
  ] as const
  for (const [name, declared, fn] of handlers) {
    if (fn !== undefined && declared === undefined) {
      warn(`hooks.apiRoutes.app has an implementation for undeclared ${name}`)
    }
  }
  const declaredPhases = new Set<string>(declaredAppPhases(app))
  for (const phase of Object.keys(implemented.hooks ?? {}).sort()) {
    if (!declaredPhases.has(phase)) {
      warn(`hooks.apiRoutes.app has an implementation for undeclared hook phase "${phase}"`)
    }
  }
}

/**
 * Story 68.14: the post-`hooksFactory()` check of `apiRoutes.app`. A declared handler or hook phase
 * needs a function; an implementation with no declaration only warns.
 */
export function assertAppImplementations(
  apiRoutes: ApiRoutesDeclaration | undefined,
  hooks: ApiRoutesHooks | undefined,
  warn: (message: string) => void
): void {
  const declared = apiRoutes?.app ?? {}
  const implemented = hooks?.app ?? {}
  assertAppFunction(declared.errorHandler, implemented.errorHandler, 'errorHandler')
  assertAppFunction(declared.notFoundHandler, implemented.notFoundHandler, 'notFoundHandler')
  for (const phase of declaredAppPhases(declared)) {
    if (!hasHookFunction(implemented, phase)) {
      fail(
        `apiRoutes.app declares ${article(phase)} ${phase} hook but hooks.apiRoutes.app has no function for it`
      )
    }
  }
  warnUndeclaredApp(declared, implemented, warn)
}
