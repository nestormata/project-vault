// Story 68.6 AC-5/AC-6 (design §8.2) — PV's app-wide security headers as ONE composable data
// policy. The composition sets `resolveHeaders(policy, request)` with a single `event.setHeaders`
// call per request. A CM contribution may add, change or remove anything in it (never refused,
// every difference recorded by `describeHeaderPolicyDelta`). Validation here is integrity only:
// well-formed names and values, no accidental collisions. It never limits which headers or values
// a policy may carry.
//
// Nestor 2026-10-02 (Q1): the frozen legacy extension-panel CSP is NOT part of this policy. Panel
// paths keep their own header branch in hooks.server.ts and are outside this policy (and every CM
// delta) until Story 68-11 retires the panel.
import { stripRouteGroups } from '$lib/composition/route-id.js'
import { getFrameProtectionHeaders, getHandoffSecurityHeaders } from './hardening.js'

/** What a matcher sees: the URL pathname and Kit's matched route id (`null` when none). */
export interface HeaderRequest {
  pathname: string
  routeId: string | null
}

export type HeaderMatch =
  | { exact: string }
  | { startsWith: string }
  | { routeId: string }
  | { test: (req: HeaderRequest) => boolean }

export interface HeaderRule {
  id: string
  match: HeaderMatch
  headers: Readonly<Record<string, string>>
}

/** Informational (Q2): headers a PV route `load` sets itself with `event.setHeaders`. A policy
 * that sets one of these names on that route would make SvelteKit throw "already set" there. */
export interface RouteSetHeaders {
  routeId: string
  match: HeaderMatch
  names: readonly string[]
}

export interface HeaderPolicy {
  defaults: Readonly<Record<string, string>>
  rules: readonly HeaderRule[]
  routeSetHeaders: readonly RouteSetHeaders[]
}

/** A server hook contribution's `headerPolicy` export. */
export type HeaderPolicyContribution = (pv: HeaderPolicy) => HeaderPolicy

export interface HeaderPolicyDelta {
  added: string[]
  changed: string[]
  removed: string[]
}

const MATCH_KEYS = ['exact', 'startsWith', 'routeId', 'test'] as const
// RFC 9110 §5.6.2 token.
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const FORBIDDEN_VALUE_CHARS = /[\r\n\0]/

function matchEntry(match: object): [string, unknown] | undefined {
  return Object.entries(match).find(([key]) => (MATCH_KEYS as readonly string[]).includes(key))
}

function matches(match: HeaderMatch, req: HeaderRequest): boolean {
  if ('exact' in match) return req.pathname === match.exact
  if ('startsWith' in match) return req.pathname.startsWith(match.startsWith)
  if ('routeId' in match) return req.routeId === match.routeId
  return match.test(req)
}

/** The first matching rule's headers REPLACE the defaults (rules are exclusive); otherwise the
 * defaults. Always a fresh object, so a caller cannot mutate the shared policy. */
export function resolveHeaders(policy: HeaderPolicy, req: HeaderRequest): Record<string, string> {
  const rule = policy.rules.find((candidate) => matches(candidate.match, req))
  return { ...(rule ? rule.headers : policy.defaults) }
}

function validateHeaders(where: string, headers: unknown, errors: string[]) {
  if (typeof headers !== 'object' || headers === null) {
    errors.push(`${where}: headers must be an object`)
    return
  }
  const seen = new Set<string>()
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (!TOKEN.test(name)) errors.push(`${where}: "${name}" is not a valid header name`)
    if (lower === 'set-cookie')
      errors.push(`${where}: "${name}" cannot be set through the header policy (use cookies)`)
    if (seen.has(lower)) errors.push(`${where}: header "${lower}" is set twice`)
    seen.add(lower)
    if (typeof value !== 'string' || value === '')
      errors.push(`${where}: header "${name}" must be a non-empty string`)
    else if (FORBIDDEN_VALUE_CHARS.test(value))
      errors.push(`${where}: header "${name}" value contains CR, LF or NUL`)
  }
}

function validateMatch(where: string, match: unknown, errors: string[]) {
  const keys =
    typeof match === 'object' && match !== null ? MATCH_KEYS.filter((key) => key in match) : []
  if (keys.length !== 1) {
    errors.push(`${where}: match must have exactly one of ${MATCH_KEYS.join(', ')}`)
    return
  }
  const [key, value] = matchEntry(match as object) ?? []
  const expected = key === 'test' ? 'function' : 'string'
  if (typeof value !== expected) errors.push(`${where}: match.${key} must be a ${expected}`)
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/** Integrity validation (fail fast, every problem in one message) + a deep-frozen copy. */
export function validateHeaderPolicy(policy: HeaderPolicy): HeaderPolicy {
  const errors: string[] = []
  validateHeaders('defaults', policy.defaults, errors)
  const ids = new Set<string>()
  for (const rule of policy.rules) {
    if (typeof rule.id !== 'string' || rule.id === '') {
      errors.push('every rule needs a non-empty string id')
      continue
    }
    if (ids.has(rule.id)) errors.push(`rule "${rule.id}" is defined twice`)
    ids.add(rule.id)
    validateMatch(`rule "${rule.id}"`, rule.match, errors)
    validateHeaders(`rule "${rule.id}"`, rule.headers, errors)
  }
  for (const entry of policy.routeSetHeaders) {
    validateMatch(`routeSetHeaders "${entry.routeId}"`, entry.match, errors)
  }
  if (errors.length > 0) throw new Error(`invalid header policy: ${errors.join('; ')}`)
  return deepFreeze({
    defaults: { ...policy.defaults },
    rules: policy.rules.map((rule) => ({
      id: rule.id,
      match: { ...rule.match },
      headers: { ...rule.headers },
    })),
    routeSetHeaders: policy.routeSetHeaders.map((entry) => ({
      routeId: entry.routeId,
      match: { ...entry.match },
      names: [...entry.names],
    })),
  })
}

/** A representative request for a route-level `setHeaders` entry. */
function probeFor(entry: RouteSetHeaders): HeaderRequest {
  const { match } = entry
  if ('exact' in match) return { pathname: match.exact, routeId: entry.routeId }
  if ('startsWith' in match) return { pathname: `${match.startsWith}probe`, routeId: entry.routeId }
  return { pathname: stripRouteGroups(entry.routeId), routeId: entry.routeId }
}

function labelFor(match: HeaderMatch): string {
  if ('exact' in match) return match.exact
  if ('startsWith' in match) return `${match.startsWith}…`
  if ('routeId' in match) return match.routeId
  return '(predicate)'
}

/** Q2: a policy header that a route `load` also sets is a guaranteed 500 there: fail at boot. */
function checkRouteSetHeaderConflicts(policy: HeaderPolicy) {
  const conflicts = new Map<string, string[]>()
  for (const entry of policy.routeSetHeaders) {
    const set = resolveHeaders(policy, probeFor(entry))
    const present = new Set(Object.keys(set).map((name) => name.toLowerCase()))
    for (const name of entry.names) {
      if (!present.has(name)) continue
      conflicts.set(name, [...(conflicts.get(name) ?? []), labelFor(entry.match)])
    }
  }
  if (conflicts.size === 0) return
  const messages = [...conflicts].map(
    ([name, where]) =>
      `header policy sets "${name}" on ${where.join(' and ')}, which their load also sets with ` +
      'event.setHeaders (SvelteKit would throw "already set" there): exclude those paths in your ' +
      'rule or override those pages'
  )
  throw new Error(messages.join('; '))
}

/** PV's policy with an optional server hook contribution applied. Validated, deep-frozen, and
 * checked for route-level `setHeaders` conflicts. A throwing contribution fails the boot with its
 * own error: a half-applied policy would be a silent security change. */
export function composeHeaderPolicy(
  pv: HeaderPolicy,
  contribution: HeaderPolicyContribution | undefined
): HeaderPolicy {
  if (contribution === undefined) return pv
  if (typeof contribution !== 'function') {
    throw new TypeError(
      'hooks.server: export "headerPolicy" must be a function (pv: HeaderPolicy) => HeaderPolicy ' +
        `(got ${typeof contribution})`
    )
  }
  const composed = validateHeaderPolicy(contribution(pv))
  checkRouteSetHeaderConflicts(composed)
  return composed
}

function diffHeaders(
  prefix: string,
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
  delta: HeaderPolicyDelta
) {
  const beforeMap = new Map(Object.entries(before))
  const afterMap = new Map(Object.entries(after))
  for (const name of new Set([...beforeMap.keys(), ...afterMap.keys()])) {
    const was = beforeMap.get(name)
    const now = afterMap.get(name)
    if (was === undefined) delta.added.push(`${prefix}.${name}`)
    else if (now === undefined) delta.removed.push(`${prefix}.${name}`)
    else if (was !== now) delta.changed.push(`${prefix}.${name}`)
  }
}

function sameMatch(a: HeaderMatch, b: HeaderMatch): boolean {
  const [keyA, valueA] = matchEntry(a) ?? []
  const [keyB, valueB] = matchEntry(b) ?? []
  return keyA === keyB && valueA === valueB
}

/** Q3: every difference between PV's policy and the composed one, recorded (never refused). A
 * rule whose match is a `test` predicate is reported as `(opaque match)`: its coverage cannot be
 * computed, only its identity compared. */
export function describeHeaderPolicyDelta(
  pv: HeaderPolicy,
  composed: HeaderPolicy
): HeaderPolicyDelta {
  const delta: HeaderPolicyDelta = { added: [], changed: [], removed: [] }
  diffHeaders('defaults', pv.defaults, composed.defaults, delta)
  const pvRules = new Map(pv.rules.map((rule) => [rule.id, rule]))
  const composedIds = new Set(composed.rules.map((rule) => rule.id))
  for (const rule of composed.rules) {
    const before = pvRules.get(rule.id)
    const opaque = 'test' in rule.match ? ' (opaque match)' : ''
    if (!before) {
      delta.added.push(`rules.${rule.id}${opaque}`)
      continue
    }
    if (!sameMatch(before.match, rule.match)) delta.changed.push(`rules.${rule.id}.match${opaque}`)
    diffHeaders(`rules.${rule.id}`, before.headers, rule.headers, delta)
  }
  for (const rule of pv.rules) if (!composedIds.has(rule.id)) delta.removed.push(`rules.${rule.id}`)
  const order = (rules: readonly HeaderRule[]) =>
    rules.map((rule) => rule.id).filter((id) => pvRules.has(id) && composedIds.has(id))
  if (order(pv.rules).join('\n') !== order(composed.rules).join('\n'))
    delta.changed.push('rules.order')
  const byCodeUnit = (a: string, b: string) => (a < b ? -1 : Number(a > b))
  delta.added.sort(byCodeUnit)
  delta.changed.sort(byCodeUnit)
  delta.removed.sort(byCodeUnit)
  return delta
}

/** PV's own policy (byte-identical to `main`'s `securityHeadersFor`, minus the frozen panel branch
 * which stays outside the policy, see the file comment). */
export const PV_HEADER_POLICY: HeaderPolicy = validateHeaderPolicy({
  defaults: getFrameProtectionHeaders(),
  rules: [{ id: 'handoff', match: { exact: '/handoff' }, headers: getHandoffSecurityHeaders() }],
  routeSetHeaders: [
    {
      routeId: '/(app)/shares/[token]',
      match: { startsWith: '/shares/' },
      names: ['referrer-policy'],
    },
    {
      routeId: '/external-shares/[token]',
      match: { startsWith: '/external-shares/' },
      names: ['referrer-policy'],
    },
  ],
})
