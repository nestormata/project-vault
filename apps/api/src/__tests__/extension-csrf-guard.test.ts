/* eslint-disable security/detect-non-literal-fs-filename */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Story 25.6 AC8/Task 6, Pre-mortem Analysis finding — mirrors `route-audit.test.ts`'s and
 * `check-native-credential-surface.ts`'s own structural-CI-guard precedent: a forgotten security
 * check can't be caught by types alone, so this re-scans the live tree on every test run rather
 * than trusting a hand-maintained list. Fails the build the moment a POST/PUT/DELETE `secureRoute`
 * registration under `apps/api/src/extensions/` does not call `isRejectedByCsrfToken(` somewhere
 * in its own handler body — the exact defense this story's own Pre-mortem round imagined a future
 * engineer forgetting six months from now when adding a new mutating extension route.
 */

const EXTENSIONS_DIR = resolve(process.cwd(), 'src/extensions')
const MUTATING_METHODS = new Set(['POST', 'PUT', 'DELETE'])

type SecureRouteRegistration = { method: string; url: string; callsCsrfCheck: boolean }

function tsFilesUnder(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir)) {
    const fullPath = resolve(dir, entry)
    const stat = statSync(fullPath)
    if (stat.isDirectory()) {
      files.push(...tsFilesUnder(fullPath))
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      files.push(fullPath)
    }
  }
  return files.sort()
}

function literalText(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return undefined
}

function objectProperty(
  object: ts.ObjectLiteralExpression,
  name: string
): ts.Expression | undefined {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    const propName = property.name
    const propNameText =
      ts.isIdentifier(propName) || ts.isStringLiteral(propName) ? propName.text : undefined
    if (propNameText === name) return property.initializer
  }
  return undefined
}

/**
 * Walks the handler's ACTUAL AST subtree looking for a real `isRejectedByCsrfToken(...)` call
 * expression — NOT a textual/`getText()` substring search. A substring search over the handler's
 * source text (comments included) can be satisfied by a stray comment mentioning the function
 * name without ever calling it, silently defeating the guard. Comments are not part of the AST,
 * so this walk can never be fooled that way.
 */
function callsIsRejectedByCsrfToken(node: ts.Node): boolean {
  let found = false
  function visit(current: ts.Node): void {
    if (found) return
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      current.expression.text === 'isRejectedByCsrfToken'
    ) {
      found = true
      return
    }
    ts.forEachChild(current, visit)
  }
  visit(node)
  return found
}

function secureRouteRegistrationFromCall(node: ts.CallExpression): SecureRouteRegistration | null {
  if (!ts.isIdentifier(node.expression) || node.expression.text !== 'secureRoute') return null
  const secondArgument = node.arguments[1]
  if (!secondArgument || !ts.isObjectLiteralExpression(secondArgument)) return null

  const method = literalText(objectProperty(secondArgument, 'method'))
  const url = literalText(objectProperty(secondArgument, 'url'))
  if (!method || !url) return null

  const handler = objectProperty(secondArgument, 'handler')
  return {
    method,
    url,
    callsCsrfCheck: handler !== undefined && callsIsRejectedByCsrfToken(handler),
  }
}

/** Extracts every `secureRoute(fastify, { method, url, handler })` call in an already-parsed AST. */
function secureRouteRegistrationsFromSourceFile(file: ts.SourceFile): SecureRouteRegistration[] {
  const registrations: SecureRouteRegistration[] = []

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const route = secureRouteRegistrationFromCall(node)
      if (route) registrations.push(route)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return registrations
}

/** Extracts every `secureRoute(fastify, { method, url, handler })` call in a source file. */
function secureRouteRegistrations(filePath: string): SecureRouteRegistration[] {
  const source = readFileSync(filePath, 'utf-8')
  const file = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  return secureRouteRegistrationsFromSourceFile(file)
}

describe('Story 25.6 AC8/Task 6: every mutating apps/api/src/extensions/ route carries the CSRF check', () => {
  it('every POST/PUT/DELETE secureRoute registration under src/extensions/ calls isRejectedByCsrfToken()', () => {
    const violations: string[] = []

    for (const filePath of tsFilesUnder(EXTENSIONS_DIR)) {
      for (const route of secureRouteRegistrations(filePath)) {
        if (!MUTATING_METHODS.has(route.method)) continue
        if (!route.callsCsrfCheck) {
          violations.push(`${filePath}: ${route.method} ${route.url}`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('sanity check: the guard actually found the known mutating route (a guard that finds nothing is not testing anything)', () => {
    const registrations = tsFilesUnder(EXTENSIONS_DIR).flatMap((filePath) =>
      secureRouteRegistrations(filePath).map((route) => ({ ...route, filePath }))
    )
    const mutating = registrations.filter((route) => MUTATING_METHODS.has(route.method))

    expect(mutating.length).toBeGreaterThan(0)
    expect(mutating.some((route) => route.url === '/extensions/panels/:slot/actions')).toBe(true)
  })

  it('regression: a handler that only MENTIONS isRejectedByCsrfToken in a comment (never calls it) is still flagged as a violation', () => {
    // Code review finding: an earlier version of this guard used a textual `getText().includes(...)`
    // search over the handler's source, which a stray comment could satisfy without the handler
    // ever actually calling the function. This pins that a comment-only mention is NOT enough.
    const source = `
      secureRoute(fastify, {
        method: 'POST',
        url: '/extensions/fake-route',
        handler: async (ctx, req, reply) => {
          // isRejectedByCsrfToken( — mentioned here, but never actually called
          return reply.status(200).send({ ok: true })
        },
      })
    `
    const file = ts.createSourceFile(
      'fake.ts',
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    )
    const registrations = secureRouteRegistrationsFromSourceFile(file)

    expect(registrations).toHaveLength(1)
    expect(registrations[0]?.callsCsrfCheck).toBe(false)
  })
})
