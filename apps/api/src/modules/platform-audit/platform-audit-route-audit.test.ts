import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Story 9.4 AC-10: regression guard (sibling to Story 9.2's
 * `platform-admin-route-audit.test.ts`) asserting every route under `modules/platform-audit/`
 * has `requireOrgScope: false`, `requireMfa: true`, `requirePlatformOperator: true`, and zero
 * `allowedRoles` entries — the load-bearing guard against a future refactor accidentally dropping
 * the MFA/platform-operator requirement.
 */

const PLATFORM_AUDIT_ROUTE_FILES = ['modules/platform-audit/routes.ts']

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

describe('Story 9.4 AC-10: platform-audit route family authorization guard', () => {
  it('every route in modules/platform-audit/ has requireOrgScope: false, requireMfa: true, requirePlatformOperator: true, and no allowedRoles', () => {
    const violations: string[] = []
    for (const path of PLATFORM_AUDIT_ROUTE_FILES) {
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
        if (!/requirePlatformOperator:\s*true/.test(call.text)) {
          violations.push(`${path}: missing requirePlatformOperator: true`)
        }
        if (/allowedRoles/.test(call.text)) {
          violations.push(`${path}: must not use allowedRoles`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('modules/platform-audit/ is a distinct module from modules/platform-admin/ (separate concept: audit read/verify vs. instance administration)', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/modules/platform-audit/routes.ts'),
      'utf-8'
    )
    expect(source).not.toMatch(/from ['"]\.\.\/platform-admin\//)
  })
})
