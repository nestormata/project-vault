/* eslint-disable security/detect-non-literal-fs-filename */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { MFA_ENROLLMENT_EXEMPT_ROUTES } from '@project-vault/shared'
import {
  DIRECT_DB_ACCESS_CLASSIFICATIONS,
  HELPER_ROUTE_REGISTRATION_CLASSIFICATIONS,
  PUBLIC_ROUTE_EXEMPTIONS,
  ROUTE_ACTION_CLASSIFICATIONS,
} from '../lib/route-exemptions.js'

export const EXEMPT_PATHS = new Set([
  '/health',
  '/ready',
  '/metrics',
  '/api/v1/vault/init',
  '/api/v1/vault/unseal',
  '/api/v1/auth/register',
  '/api/v1/auth/login',
  '/api/v1/auth/refresh',
  '/api/v1/auth/mfa/recover',
  '/api/v1/auth/mfa/verify-login',
])

const SRC_ROOT = resolve(process.cwd(), 'src')
const FASTIFY_SHORTHANDS = ['get', 'post', 'put', 'patch', 'delete'] as const
const ROUTE_ACTION_CLASSIFICATION_ENTRIES = Object.entries(ROUTE_ACTION_CLASSIFICATIONS)
const ROUTE_ACTION_CLASSIFICATION_MAP = new Map(ROUTE_ACTION_CLASSIFICATION_ENTRIES)

type ParsedRoute = {
  method: string
  url: string
  preHandlerSource: string
  source: string
  registrar: string
}

type RouteFile = { path: string; prefix: string }
type ParsedProductionRoute = RouteFile & { route: ParsedRoute; routeKey: string }

function tsFilesUnder(relativeDir: string): string[] {
  const root = resolve(SRC_ROOT, relativeDir)
  const files: string[] = []
  function visit(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const fullPath = resolve(dir, entry)
      const stat = statSync(fullPath)
      if (stat.isDirectory()) {
        visit(fullPath)
      } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
        files.push(fullPath.slice(SRC_ROOT.length + 1))
      }
    }
  }
  visit(root)
  return files.sort()
}

function workerFiles(): string[] {
  return tsFilesUnder('workers')
}

function routeFilesForDbScan(): string[] {
  return [
    ...tsFilesUnder('routes'),
    ...tsFilesUnder('modules').filter((path) => path.endsWith('/routes.ts')),
  ].sort()
}

function sourceFile(source: string, path = 'route.ts'): ts.SourceFile {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}

function literalText(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return undefined
}

function moduleStringConstants(source: string): Map<string, string> {
  const constants = new Map<string, string>()
  const file = sourceFile(source)
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue
      const value = literalText(decl.initializer)
      if (value !== undefined) constants.set(decl.name.text, value)
    }
  }
  return constants
}

function literalTextFromNode(
  node: ts.Expression | undefined,
  constants: Map<string, string>
): string | undefined {
  const direct = literalText(node)
  if (direct !== undefined) return direct
  if (node && ts.isIdentifier(node)) return constants.get(node.text)
  return undefined
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))
    return name.text
  return undefined
}

function objectProperty(
  object: ts.ObjectLiteralExpression,
  name: string
): ts.Expression | undefined {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue
    if (propertyNameText(property.name) === name) return property.initializer
  }
  return undefined
}

function routeFromOptions(
  object: ts.ObjectLiteralExpression,
  registrar: string,
  constants: Map<string, string>,
  fallbackMethod?: string
): ParsedRoute | null {
  const method = fallbackMethod ?? literalTextFromNode(objectProperty(object, 'method'), constants)
  const url = literalTextFromNode(objectProperty(object, 'url'), constants)
  const security = objectProperty(object, 'security')
  const preHandler = objectProperty(object, 'preHandler')
  const preHandlerSource = (security ?? preHandler)?.getText() ?? ''
  if (!method && !url) return null
  return {
    method: method ?? '<dynamic>',
    url: url ?? '<dynamic>',
    preHandlerSource,
    source: object.getFullText(),
    registrar,
  }
}

function importPathToSourcePath(moduleSpecifier: string): string | null {
  if (!moduleSpecifier.startsWith('./')) return null
  return moduleSpecifier.replace(/^\.\//, '').replace(/\.js$/, '.ts')
}

function registeredRouteFromCall(
  node: ts.CallExpression,
  imports: Map<string, string>
): RouteFile | null {
  if (!ts.isPropertyAccessExpression(node.expression)) return null
  if (node.expression.name.text !== 'register') return null
  const firstArgument = node.arguments[0]
  if (!firstArgument || !ts.isIdentifier(firstArgument)) return null
  const routePath = imports.get(firstArgument.text)
  if (!routePath) return null
  const options = node.arguments[1]
  const prefix =
    options && ts.isObjectLiteralExpression(options)
      ? (literalText(objectProperty(options, 'prefix')) ?? '')
      : ''
  return { path: routePath, prefix }
}

function productionRouteFiles(): RouteFile[] {
  const appSource = readFileSync(resolve(SRC_ROOT, 'app.ts'), 'utf-8')
  const app = sourceFile(appSource, 'app.ts')
  const imports = new Map<string, string>()
  const routes: RouteFile[] = []

  for (const statement of app.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue
    const importedPath = importPathToSourcePath(statement.moduleSpecifier.text)
    if (!importedPath) continue
    const namedBindings = statement.importClause?.namedBindings
    if (!namedBindings || !ts.isNamedImports(namedBindings)) continue
    for (const specifier of namedBindings.elements) {
      imports.set(specifier.name.text, importedPath)
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const route = registeredRouteFromCall(node, imports)
      if (route) routes.push(route)
    }
    ts.forEachChild(node, visit)
  }
  visit(app)

  return [...new Map(routes.map((route) => [route.path, route])).values()].sort((a, b) =>
    a.path.localeCompare(b.path)
  )
}

function rawRegisteredRoute(
  node: ts.CallExpression,
  constants: Map<string, string>
): ParsedRoute | null {
  if (!ts.isPropertyAccessExpression(node.expression)) return null
  if (node.expression.name.text !== 'route') return null
  const firstArgument = node.arguments[0]
  if (!firstArgument || !ts.isObjectLiteralExpression(firstArgument)) return null
  return routeFromOptions(firstArgument, 'fastify.route', constants)
}

function shorthandRegisteredRoute(node: ts.CallExpression): ParsedRoute | null {
  if (!ts.isPropertyAccessExpression(node.expression)) return null
  const registrar = node.expression.name.text
  if (!(FASTIFY_SHORTHANDS as readonly string[]).includes(registrar)) return null
  const url = literalText(node.arguments[0])
  return {
    method: registrar.toUpperCase(),
    url: url ?? '<dynamic>',
    preHandlerSource: node.arguments[1]?.getText() ?? '',
    source: node.getFullText(),
    registrar: `fastify.${registrar}`,
  }
}

function parseRawRouteDeclarations(source: string): ParsedRoute[] {
  const constants = moduleStringConstants(source)
  const routes: ParsedRoute[] = []
  const file = sourceFile(source)

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const route = rawRegisteredRoute(node, constants) ?? shorthandRegisteredRoute(node)
      if (route) routes.push(route)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return routes
}

function parseRoutes(source: string): ParsedRoute[] {
  const constants = moduleStringConstants(source)
  const secureRoutes: ParsedRoute[] = []
  const file = sourceFile(source)
  function visit(node: ts.Node): void {
    const secondArgument = ts.isCallExpression(node) ? node.arguments[1] : undefined
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'secureRoute' &&
      secondArgument &&
      ts.isObjectLiteralExpression(secondArgument)
    ) {
      const route = routeFromOptions(secondArgument, 'secureRoute', constants)
      if (route) secureRoutes.push(route)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return [...parseRawRouteDeclarations(source), ...secureRoutes]
}

function parsedProductionRoutes(): ParsedProductionRoute[] {
  const entries: ParsedProductionRoute[] = []
  for (const { path, prefix } of productionRouteFiles()) {
    const source = readFileSync(resolve(process.cwd(), 'src', path), 'utf-8')
    for (const route of parseRoutes(source)) {
      entries.push({ path, prefix, route, routeKey: routeKeyFor(route, prefix) })
    }
  }
  return entries
}

function requiresOwnerOrAdmin(preHandlerSource: string): boolean {
  const match = /requireOrgRole\(([^)]*)\)/.exec(preHandlerSource)
  if (match && /'owner'|'admin'/.test(match[1] ?? '')) return true
  if (/allowedRoles:\s*\[[^\]]*'(owner|admin)'/.test(preHandlerSource)) return true
  return /minimumRole:\s*'(owner|admin)'/.test(preHandlerSource)
}

function routeKeyFor(route: ParsedRoute, prefix: string): string {
  return `${route.method} ${prefix}${route.url}`
}

function isRawApiRoute(route: ParsedRoute, routeKey: string, prefix: string): boolean {
  if (route.registrar === 'secureRoute') return false
  if (routeKey.includes('/api/v1/') || routeKey.endsWith(' /api/v1')) return true
  return route.url === '<dynamic>' && prefix.startsWith('/api/v1')
}

function missingActionClassification(
  route: ParsedRoute,
  routeKey: string,
  classified: Set<string>
): boolean {
  if (route.registrar !== 'secureRoute') return false
  if (!routeKey.includes('/api/v1/')) return false
  return !classified.has(routeKey)
}

function assertClassifiedHelpers(): void {
  const classifiedHelpers = new Set(Object.keys(HELPER_ROUTE_REGISTRATION_CLASSIFICATIONS))
  const helperViolations: string[] = []
  for (const { path } of productionRouteFiles()) {
    const source = readFileSync(resolve(process.cwd(), 'src', path), 'utf-8')
    for (const helper of helperRegistrars(source)) {
      if (!classifiedHelpers.has(helper)) helperViolations.push(`${path}: ${helper}`)
    }
  }
  expect(helperViolations).toEqual([])
}

function assertClassifiedProtectedRoutes(): void {
  const classifiedRoutes = new Set(Object.keys(ROUTE_ACTION_CLASSIFICATIONS))
  const routeViolations: string[] = []
  for (const { route, routeKey } of parsedProductionRoutes()) {
    if (missingActionClassification(route, routeKey, classifiedRoutes)) {
      routeViolations.push(routeKey)
    }
  }
  expect(routeViolations).toEqual([])
}

function assertClassificationMetadata(): void {
  for (const [route, classification] of ROUTE_ACTION_CLASSIFICATION_ENTRIES) {
    expect(route).toMatch(/^[A-Z]+ \/api\/v1\//)
    expect(['read', 'sensitive-read', 'mutation', 'security-action']).toContain(
      classification.action
    )
    if (
      (classification.action === 'mutation' || classification.action === 'security-action') &&
      !classification.auditEvent
    ) {
      expect(classification.auditOmissionReason).toBeTruthy()
      expect(classification.reviewer).toBeTruthy()
    }
  }
}

function assertAuditedActionOptOutsAreJustified(): void {
  const violations: string[] = []

  for (const { route, routeKey } of parsedProductionRoutes()) {
    const classification = ROUTE_ACTION_CLASSIFICATION_MAP.get(routeKey)
    if (!classification?.auditEvent) continue
    if (!/writeAuditEvent:\s*false/.test(route.source)) continue
    const delegatedService = classification.sameTransactionAuditService
    const serviceCallIndex = delegatedService ? route.source.indexOf(`${delegatedService}(`) : -1
    const txArgumentIndex =
      serviceCallIndex === -1 ? -1 : route.source.indexOf('secureCtx.tx', serviceCallIndex)
    const delegatesAuditThroughTx = serviceCallIndex !== -1 && txArgumentIndex !== -1
    if (delegatesAuditThroughTx) continue

    violations.push(routeKey)
  }

  expect(violations).toEqual([])
}

function helperRegistrars(source: string): string[] {
  const helpers: string[] = []
  for (const match of source.matchAll(/function\s+(\w+)\s*\([^)]*fastify[^)]*\)\s*:\s*[^{]+\{/g)) {
    const name = match[1] ?? ''
    if (!name || name.endsWith('Routes')) continue
    const body = source.slice(match.index ?? 0, source.indexOf('\n}\n', match.index ?? 0) + 3)
    if (/fastify\.(route|get|post|put|patch|delete)\(/.test(body)) helpers.push(name)
  }
  return helpers
}

describe('route audit', () => {
  it('every non-public /api/v1 route is registered via SecureRoute', () => {
    const publicRoutes = new Set(PUBLIC_ROUTE_EXEMPTIONS.map((entry) => entry.route))
    const violations: string[] = []

    for (const { path, prefix, route, routeKey } of parsedProductionRoutes()) {
      if (route.registrar === 'secureRoute' || publicRoutes.has(routeKey)) continue
      if (!isRawApiRoute(route, routeKey, prefix)) continue
      violations.push(`${path}: ${routeKey} uses ${route.registrar}`)
    }

    expect(violations).toEqual([])
  })

  it('public route exemptions include required security metadata', () => {
    expect(PUBLIC_ROUTE_EXEMPTIONS).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          route: 'POST /api/v1/auth/login',
          reason: expect.any(String),
          securityOwner: expect.any(String),
          compensatingControls: expect.arrayContaining([expect.any(String)]),
          expiresAfterStory: null,
        }),
      ])
    )

    for (const exemption of PUBLIC_ROUTE_EXEMPTIONS) {
      expect(exemption.route).toMatch(/^[A-Z]+ \//)
      expect(exemption.reason.trim().length).toBeGreaterThan(10)
      expect(exemption.securityOwner.trim().length).toBeGreaterThan(0)
      expect(exemption.compensatingControls.length).toBeGreaterThan(0)
      if (exemption.temporary) {
        expect(exemption.expiresAfterStory ?? exemption.revisitBy).toBeTruthy()
      }
    }
  })

  it('classifies route-registering helpers and protected route actions', () => {
    expect(HELPER_ROUTE_REGISTRATION_CLASSIFICATIONS).toMatchObject({
      secureRoute: 'secure',
      registerMethodNotAllowed: 'shell-only',
    })

    assertClassifiedHelpers()
    assertClassifiedProtectedRoutes()
    assertClassificationMetadata()
    assertAuditedActionOptOutsAreJustified()
  })

  it('does not use the legacy protected-route helper after SecureRoute migration', () => {
    const authSource = readFileSync(resolve(process.cwd(), 'src/modules/auth/routes.ts'), 'utf-8')

    expect(authSource).not.toContain('registerProtectedRoute(fastify')
  })

  it('requires direct getDb imports in route and worker modules to be classified', () => {
    const classifiedPaths = new Set(DIRECT_DB_ACCESS_CLASSIFICATIONS.map((entry) => entry.path))
    const violations: string[] = []

    for (const path of [...routeFilesForDbScan(), ...workerFiles()]) {
      const source = readFileSync(resolve(process.cwd(), 'src', path), 'utf-8')
      if (
        (/import\s+\{[^}]*\bgetDb\b/.test(source) ||
          /import\s+\*\s+as\s+\w+\s+from\s+['"]@project-vault\/db['"]/.test(source)) &&
        !classifiedPaths.has(path)
      ) {
        violations.push(path)
      }
    }

    for (const classification of DIRECT_DB_ACCESS_CLASSIFICATIONS) {
      expect(classification.reason.trim().length).toBeGreaterThan(10)
      expect(classification.reviewer.trim().length).toBeGreaterThan(0)
    }
    expect(violations).toEqual([])
  })

  it('does not spread raw request params, query, or body into audit payload builders', () => {
    const violations: string[] = []
    const files = [
      'lib/secure-route.ts',
      'modules/auth/service.ts',
      'modules/auth/mfa.ts',
      'modules/auth/session-revoke.ts',
      'workers/check-failed-auth-threshold.ts',
    ]

    for (const path of files) {
      const source = readFileSync(resolve(process.cwd(), 'src', path), 'utf-8')
      if (/\.\.\.\s*(req|request)\.(params|query|body)/.test(source)) violations.push(path)
    }

    expect(violations).toEqual([])
  })

  it('every owner/admin route requires MFA enrollment unless explicitly exempt (AC-5b/AC-5c)', () => {
    const violations: string[] = []

    for (const { route, routeKey } of parsedProductionRoutes()) {
      if (!requiresOwnerOrAdmin(route.preHandlerSource)) continue

      const hasMfaCheck =
        route.preHandlerSource.includes('requireMfaEnrollment()') ||
        /requireMfa:\s*true/.test(route.preHandlerSource)
      const isExempt = (MFA_ENROLLMENT_EXEMPT_ROUTES as readonly string[]).includes(routeKey)

      if (!hasMfaCheck && !isExempt) {
        violations.push(routeKey)
      }
    }

    expect(violations).toEqual([])
  })

  it('uses the shared MFA enrollment exempt route registry', () => {
    const sharedRegistrySource = readFileSync(
      resolve(process.cwd(), '../../packages/shared/src/constants/mfa-exempt-routes.ts'),
      'utf-8'
    )

    expect(sharedRegistrySource).toContain('GET /api/v1/org/security-alerts')
    expect(sharedRegistrySource).toContain('GET /api/v1/auth/me')
  })

  it('requires MFA on the existing owner/admin session-revoke route', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/modules/org/routes.ts'),
      'utf-8'
    ).replace(/\s+/g, ' ')

    expect(source).toContain("url: '/users/:userId/sessions'")
    expect(source).toMatch(/allowedRoles:\s*\['admin', 'owner'\]/)
    expect(source).toMatch(/requireMfa:\s*true/)
  })

  it('does not import the test-only privileged route helper from production entrypoints', () => {
    const appSource = readFileSync(resolve(process.cwd(), 'src/app.ts'), 'utf-8')
    const mainSource = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf-8')

    expect(appSource).not.toContain('privileged-test-route')
    expect(mainSource).not.toContain('privileged-test-route')
  })
})
