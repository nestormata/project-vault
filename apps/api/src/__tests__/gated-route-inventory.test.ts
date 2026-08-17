/* eslint-disable security/detect-non-literal-fs-filename */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Story 23.3 AC-14 — the sole mechanism bounding the gated surface's blast radius.
 * `UNGATABLE_URL_PREFIXES` is deliberately NOT implemented (every reading of it was broken — see
 * the story's Dev Notes). Instead: the complete list of routes annotated with
 * `security.capability` must deep-equal this literal golden array. Growing the gated surface, on
 * any route, of any sensitivity, requires an explicit, reviewable diff to THIS array.
 *
 * Never-gate categories (a written review rule, not a fake check — no test in this codebase can
 * see a route's full URL at Fastify registration time): authentication, session, and token
 * issuance/refresh; MFA enrollment and account recovery; audit read/export; backup and export;
 * platform-operator/admin surfaces; and /health / /status. A reviewer approving a diff to this
 * array that adds one of those surfaces would defeat this bound — the mitigation is that the diff
 * is small, isolated, and sits next to this comment.
 */
const GOLDEN_GATED_ROUTES = [
  'POST /api/v1/projects/:projectId/status-page', // AC-23, declarative
  'GET /api/v1/status-pages/:token', // AC-24, imperative (assertCapability)
] as const

/** AC-24's imperative call site — file path relative to `src/`. */
const IMPERATIVE_CALL_SITE_FILE = 'modules/monitoring/public-status-page-routes.ts'

const SRC_ROOT = resolve(process.cwd(), 'src')

type CapabilityAnnotation = { method: string; url: string }

const NON_LITERAL_URL = '<non-literal-url>'

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stats = statSync(full)
    if (stats.isDirectory()) {
      walk(full, out)
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

/** Given the index of an opening `{`, returns the index just past its matching `}`. */
function matchBrace(source: string, openIndex: number): number {
  let depth = 0
  for (let i = openIndex; i < source.length; i += 1) {
    const char = source.charAt(i)
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  throw new Error('gated-route-inventory: unbalanced braces while scanning source')
}

function routeObjectHasCapabilityAnnotation(routeObject: string): boolean {
  const securityMatch = /security:\s*\{/.exec(routeObject)
  if (!securityMatch) return false
  const securityOpen = securityMatch.index + securityMatch[0].length - 1
  const securityClose = matchBrace(routeObject, securityOpen)
  const securityBlock = routeObject.slice(securityOpen, securityClose)
  return /capability:\s*CapabilityId\./.test(securityBlock)
}

/**
 * AC-14's scan is deliberately tolerant of a named url constant (e.g. `STATUS_PAGE_URL`) rather
 * than requiring a string literal — it resolves the identifier against the same file's top-level
 * `const NAME = '...'` declaration.
 */
function resolveRouteUrl(routeObject: string, source: string): string {
  const urlLiteralMatch = /url:\s*'([^']*)'/.exec(routeObject)
  if (urlLiteralMatch) return urlLiteralMatch[1] ?? NON_LITERAL_URL
  const identifierMatch = /url:\s*([A-Za-z_$][\w$]*)\s*,/.exec(routeObject)
  const identifier = identifierMatch?.[1]
  if (!identifier) return NON_LITERAL_URL
  // identifier is captured from a fixed \w-only pattern above, not attacker/external input.
  // eslint-disable-next-line security/detect-non-literal-regexp
  const constMatch = new RegExp(`const ${identifier} = '([^']*)'`).exec(source)
  return constMatch?.[1] ?? NON_LITERAL_URL
}

/**
 * A deliberately simple, balanced-brace source scan (not a full AST parse): finds every
 * `secureRoute(fastify, { ... })` call's top-level route-options object, and within it, a nested
 * `security: { ... }` object containing `capability: CapabilityId.X`. Good enough to bound the
 * inventory without a TypeScript compiler dependency — the golden array above is the actual
 * enforcement; this scan is only how the test discovers what to compare it against.
 */
function findCapabilityAnnotatedRoutes(): CapabilityAnnotation[] {
  const found: CapabilityAnnotation[] = []
  for (const file of walk(SRC_ROOT)) {
    const source = readFileSync(file, 'utf-8')
    const callRegex = /secureRoute\(\s*fastify\s*,\s*\{/g
    let call: RegExpExecArray | null
    while ((call = callRegex.exec(source))) {
      const objOpen = call.index + call[0].length - 1
      const objClose = matchBrace(source, objOpen)
      const routeObject = source.slice(objOpen, objClose)
      if (!routeObjectHasCapabilityAnnotation(routeObject)) continue

      const methodMatch = /method:\s*'([A-Z]+)'/.exec(routeObject)
      found.push({
        method: methodMatch?.[1] ?? '<unknown>',
        url: resolveRouteUrl(routeObject, source),
      })
    }
  }
  return found
}

describe('gated-route-inventory — AC-14 blast-radius bound', () => {
  it('the declarative (security.capability-annotated) routes deep-equal the golden array subset', () => {
    const annotated = findCapabilityAnnotatedRoutes()
    // Every current annotated route lives under the /api/v1/projects/ prefix.
    const asStrings = annotated.map((route) => `${route.method} /api/v1/projects${route.url}`)
    expect(asStrings).toEqual(['POST /api/v1/projects/:projectId/status-page'])
  })

  it("assertCapability (the imperative form) is imported only by the golden inventory's imperative call site (AC-21)", () => {
    const importers: string[] = []
    for (const file of walk(SRC_ROOT)) {
      const source = readFileSync(file, 'utf-8')
      if (
        /from ['"].*\/capability-gate\.js['"]/.test(source) &&
        /\bassertCapability\b/.test(source)
      ) {
        if (
          !source.includes('export function assertCapability') &&
          !file.endsWith('capability-gate.ts')
        ) {
          importers.push(file.slice(SRC_ROOT.length + 1))
        }
      }
    }
    expect(importers).toEqual([IMPERATIVE_CALL_SITE_FILE])
  })

  it('never-gate categories are absent from the golden array (review-enforced, spot-checked here)', () => {
    const forbiddenSubstrings = [
      '/auth/',
      '/sessions',
      '/tokens',
      '/mfa/',
      '/recovery',
      '/audit',
      '/backup',
      '/admin/',
      '/health',
      '/status"',
    ]
    for (const route of GOLDEN_GATED_ROUTES) {
      for (const forbidden of forbiddenSubstrings) {
        expect(route.includes(forbidden)).toBe(false)
      }
    }
  })

  it('the golden array is exactly two entries — the AC-23/AC-24 pair this story registers', () => {
    expect(GOLDEN_GATED_ROUTES).toHaveLength(2)
  })
})
