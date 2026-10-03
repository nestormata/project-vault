// Story 68.6 AC-2 (design §8.1) — the contribution contract for SvelteKit hooks. Client-safe: the
// universal and client hook files use it too. One implementation per rule; the server-only
// `handle` composition lives in `$lib/server/composition/compose-handles.ts`.
//
// A contributed hook is either a chain entry (a function, or an object for `transport`) composed
// "CM first, then PV", or `{ wrap }`, which receives PV's hook and returns the replacement. When
// neither PV nor the contribution defines a hook the composed export is `undefined`, never a no-op
// function, so SvelteKit's own default (error logging, `Bad Request`, passthrough fetch, noop
// reroute, `{}` transport) still runs exactly as without composition (Q7).
//
// Entries are called as plain functions (no receiver). A throw or rejection inside any entry
// propagates exactly as from PV's own hook: nothing here catches, retries or falls back.

export type HookFile = 'server' | 'universal' | 'client'

type Fn = (...args: unknown[]) => unknown
type Wrap = (pv: unknown) => unknown

interface Entry {
  chain?: unknown
  wrap?: Wrap
}

export interface HandleContribution<H> {
  before: H[]
  after: H[]
  wrap: ((pv: H) => H) | undefined
}

function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object') return `object with keys ${Object.keys(value).join(', ')}`
  return typeof value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readEntry(file: HookFile, name: string, value: unknown): Entry | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'function') return { chain: value }
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
    if (keys.length === 1 && keys[0] === 'wrap' && typeof value.wrap === 'function')
      return { wrap: value.wrap as Wrap }
    // `transport` is the one hook whose chain entry is an object (a map of transport types).
    if (name === 'transport' && typeof value.wrap !== 'function') return { chain: value }
  }
  throw new TypeError(
    `hooks.${file}: export "${name}" must be a function or { wrap } (got ${describeValue(value)})`
  )
}

function functionList(name: string, key: string, value: unknown): Fn[] {
  if (value === undefined) return []
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'function')) return value
  throw new TypeError(`hooks.server: export "${name}" ${key} must be an array of functions`)
}

/** The server `handle` contribution: a function is one `before` entry; otherwise
 * `{ before?, after?, wrap? }` (Q10: `before` runs outermost, `after` inside PV right before
 * Kit's `resolve`, `wrap` replaces PV's handle in place). */
export function readHandleContribution<H = Fn>(value: unknown): HandleContribution<H> {
  if (value === undefined) return { before: [], after: [], wrap: undefined }
  if (typeof value === 'function') return { before: [value as H], after: [], wrap: undefined }
  const known = ['before', 'after', 'wrap']
  if (!isPlainObject(value) || Object.keys(value).some((key) => !known.includes(key))) {
    throw new TypeError(
      'hooks.server: export "handle" must be a function or { before?, after?, wrap? } ' +
        `(got ${describeValue(value)})`
    )
  }
  if (value.wrap !== undefined && typeof value.wrap !== 'function')
    throw new TypeError('hooks.server: export "handle" wrap must be a function')
  return {
    before: functionList('handle', 'before', value.before) as H[],
    after: functionList('handle', 'after', value.after) as H[],
    wrap: value.wrap as ((pv: H) => H) | undefined,
  }
}

/** Runs `next` on a value that may or may not be a promise, staying synchronous when it is not
 * (Kit's `reroute` may be synchronous). */
function then<T>(value: unknown, next: (resolved: unknown) => T): T | Promise<T> {
  return value instanceof Promise ? value.then(next) : next(value)
}

/** What `wrap` receives as `pv` when PV defines no such hook: behaviour equal to Kit's default
 * for the composition (`undefined` results, passthrough fetch, empty transport). */
const PV_DEFAULTS = new Map<string, unknown>([
  ['handleError', () => undefined],
  ['handleValidationError', () => undefined],
  ['init', () => undefined],
  [
    'handleFetch',
    ({ request, fetch }: { request: Request; fetch: typeof globalThis.fetch }) => fetch(request),
  ],
  ['reroute', () => undefined],
  ['transport', {}],
])

function chainOf(file: HookFile, name: string, pv: unknown, cm: unknown): unknown {
  const p = pv as Fn
  const c = cm as Fn
  switch (name) {
    case 'handleError':
      // C then P, both awaited in order; C's result unless it is undefined.
      return (input: unknown) =>
        then(c(input), (fromC) => then(p(input), (fromP) => (fromC === undefined ? fromP : fromC)))
    case 'handleValidationError':
    case 'reroute':
      // C first; the first non-undefined result wins.
      return (input: unknown) => then(c(input), (fromC) => (fromC === undefined ? p(input) : fromC))
    case 'init':
      return () => then(c(), () => p())
    case 'handleFetch':
      return (input: { request: Request; fetch: typeof globalThis.fetch }) =>
        c({
          ...input,
          fetch: (info: RequestInfo | URL, init?: RequestInit) =>
            p({ ...input, request: new Request(info, init) }),
        })
    case 'transport': {
      const pvTransport = pv as Record<string, unknown>
      const shared = Object.keys(cm as object).filter((key) => Object.hasOwn(pvTransport, key))
      if (shared.length > 0) {
        throw new Error(
          `hooks.${file}: transport type "${shared.join('", "')}" is defined by both PV and the ` +
            "contribution; use { wrap } to replace PV's"
        )
      }
      return { ...pvTransport, ...(cm as object) }
    }
    default:
      throw new Error(`no chain semantics for hook "${name}"`)
  }
}

function applyWrap(file: HookFile, name: string, wrap: Wrap, pv: unknown): unknown {
  const wrapped = wrap(pv ?? PV_DEFAULTS.get(name))
  const expected = name === 'transport' ? 'object' : 'function'
  if (typeof wrapped !== expected || wrapped === null) {
    const article = expected === 'object' ? 'an object' : 'a function'
    throw new TypeError(
      `hooks.${file}: wrap for "${name}" must return ${article} (got ${describeValue(wrapped)})`
    )
  }
  return wrapped
}

/** Composes one non-`handle` hook from PV's own (`pv`, possibly undefined) and a contribution
 * (`contributed`, possibly undefined). See the AC-2 table in docs/composition-kit.md. */
export function composeChainHook(
  file: HookFile,
  name: string,
  pv: unknown,
  contributed: unknown
): unknown {
  if (!PV_DEFAULTS.has(name)) throw new Error(`no chain semantics for hook "${name}"`)
  const entry = readEntry(file, name, contributed)
  if (!entry) return pv
  if (entry.wrap) return applyWrap(file, name, entry.wrap, pv)
  if (pv === undefined) return name === 'transport' ? { ...(entry.chain as object) } : entry.chain
  return chainOf(file, name, pv, entry.chain)
}
