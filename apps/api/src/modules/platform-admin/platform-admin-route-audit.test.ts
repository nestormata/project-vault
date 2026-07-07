import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Story 9.2 D2 point 3: a dedicated regression guard distinguishing this story's new
 * platform-operator-scoped (instance-wide) route family from the pre-existing org-scoped
 * `modules/admin/` module under the same `/api/v1/admin/` URL prefix. Asserts every route
 * registered in `modules/platform-admin/` has `requireOrgScope: false`, `requireMfa: true`, and
 * NO `allowedRoles` entry — the load-bearing guard against a future refactor accidentally
 * merging the two families or silently dropping the MFA requirement (which would let any org
 * Owner/Admin read/write instance-wide SMTP credentials, provision organizations, and see
 * cross-org resource usage — a privilege-escalation bug, not a cosmetic regression).
 */

const PLATFORM_ADMIN_ROUTE_FILES = [
  'modules/platform-admin/settings-routes.ts',
  'modules/platform-admin/orgs-routes.ts',
  'modules/platform-admin/resource-usage-routes.ts',
]
const ORG_SCOPED_ADMIN_ROUTE_FILE = 'modules/admin/routes.ts'

type SecureRouteCall = { text: string }

function findSecureRouteCalls(source: string): SecureRouteCall[] {
  const file = ts.createSourceFile(
    'route.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const calls: SecureRouteCall[] = []
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'secureRoute' &&
      node.arguments[1] &&
      ts.isObjectLiteralExpression(node.arguments[1])
    ) {
      calls.push({ text: node.arguments[1].getText() })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return calls
}

describe('Story 9.2 D2: platform-admin vs. org-scoped admin route-family separation', () => {
  it('every route in modules/platform-admin/ has requireOrgScope: false, requireMfa: true, and no allowedRoles', () => {
    const violations: string[] = []
    for (const path of PLATFORM_ADMIN_ROUTE_FILES) {
      const source = readFileSync(resolve(process.cwd(), 'src', path), 'utf-8')
      const calls = findSecureRouteCalls(source)
      expect(calls.length, `expected at least one secureRoute() call in ${path}`).toBeGreaterThan(0)
      for (const call of calls) {
        if (!/requireOrgScope:\s*false/.test(call.text)) {
          violations.push(`${path}: missing requireOrgScope: false`)
        }
        if (!/requireMfa:\s*true/.test(call.text)) {
          violations.push(`${path}: missing requireMfa: true`)
        }
        if (/allowedRoles/.test(call.text)) {
          violations.push(`${path}: must not use allowedRoles`)
        }
        if (!/requirePlatformOperator:\s*true/.test(call.text)) {
          violations.push(`${path}: missing requirePlatformOperator: true`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('modules/admin/ (org-scoped) routes are unaffected by this story — still allowedRoles-gated, requireOrgScope not opted out', () => {
    const source = readFileSync(resolve(process.cwd(), 'src', ORG_SCOPED_ADMIN_ROUTE_FILE), 'utf-8')
    const calls = findSecureRouteCalls(source)
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.text).toMatch(/allowedRoles/)
      expect(call.text).not.toMatch(/requireOrgScope:\s*false/)
      expect(call.text).not.toMatch(/requirePlatformOperator/)
    }
  })
})
