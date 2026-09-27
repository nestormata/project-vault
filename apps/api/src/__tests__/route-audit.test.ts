/* eslint-disable security/detect-non-literal-fs-filename */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { MFA_ENROLLMENT_EXEMPT_ROUTES } from '@project-vault/shared'
import {
  DIRECT_DB_ACCESS_CLASSIFICATIONS,
  HELPER_ROUTE_REGISTRATION_CLASSIFICATIONS,
  IP_RATE_LIMIT,
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
  // Story 9.3 AC-16: must remain reachable while the vault is sealed, same rationale as
  // /health above — see plugins/vault-guard.ts's SEALED_VAULT_EXEMPT_* constants for the actual
  // enforcement (this set documents the same classification for route-audit's own scan).
  '/api/v1/openapi.json',
  '/api/v1/docs',
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
  // Story 43.8 (AC-8): the declaring call and its options object, so the ip-rate-limit audit can
  // walk to the enclosing registrar function and inspect the route's own config/handler nodes.
  call: ts.CallExpression
  options: ts.ObjectLiteralExpression | undefined
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
  call: ts.CallExpression,
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
    call,
    options: object,
  }
}

function importPathToSourcePath(moduleSpecifier: string): string | null {
  if (!moduleSpecifier.startsWith('./')) return null
  return moduleSpecifier.replace(/^\.\//, '').replace(/\.js$/, '.ts')
}

function registeredRouteFromCall(
  node: ts.CallExpression,
  imports: Map<string, string>,
  constants: Map<string, string>
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
      ? (literalTextFromNode(objectProperty(options, 'prefix'), constants) ?? '')
      : ''
  return { path: routePath, prefix }
}

function productionRouteFiles(): RouteFile[] {
  const appSource = readFileSync(resolve(SRC_ROOT, 'app.ts'), 'utf-8')
  const app = sourceFile(appSource, 'app.ts')
  const imports = new Map<string, string>()
  const constants = moduleStringConstants(appSource)
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
      const route = registeredRouteFromCall(node, imports, constants)
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
  return routeFromOptions(node, firstArgument, 'fastify.route', constants)
}

function shorthandRegisteredRoute(node: ts.CallExpression): ParsedRoute | null {
  if (!ts.isPropertyAccessExpression(node.expression)) return null
  const registrar = node.expression.name.text
  if (!(FASTIFY_SHORTHANDS as readonly string[]).includes(registrar)) return null
  const url = literalText(node.arguments[0])
  const options = node.arguments[1]
  return {
    method: registrar.toUpperCase(),
    url: url ?? '<dynamic>',
    preHandlerSource: options?.getText() ?? '',
    source: node.getFullText(),
    registrar: `fastify.${registrar}`,
    call: node,
    options: options && ts.isObjectLiteralExpression(options) ? options : undefined,
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
      const route = routeFromOptions(node, secondArgument, 'secureRoute', constants)
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

// --- Story 43.8 AC-8: a claimed `ip-rate-limit` compensating control must be machine-verifiable ---
// Epic-43 retro Finding 3: the CLI routes listed IP_RATE_LIMIT while no @fastify/rate-limit was
// registered in their plugin scope, so their `config.rateLimit` blocks were inert. The checker is a
// pure function over source text (AST only — never substring matches, so comments/strings never
// count) so it can be proven against fixtures that reproduce each way a lenient check would pass.

/** Explicit allowlist of named, IP-keyed manual limiters (M-manual). Extend only with such helpers. */
const MANUAL_IP_RATE_LIMITERS: readonly string[] = ['enforceIpRateLimitAndNormalizeEmailBody']
const RATE_LIMIT_ENFORCED_GUARD = 'isRateLimitEnforced'

type FunctionLike =
  ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  )
}

function enclosingFunction(node: ts.Node): FunctionLike | undefined {
  let current = node.parent
  while (current && !isFunctionLike(current)) current = current.parent
  return current
}

function functionName(fn: FunctionLike | undefined): string {
  if (!fn) return '<module scope>'
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name) {
    return fn.name.getText()
  }
  return '<anonymous registrar>'
}

function rateLimitImportName(file: ts.SourceFile): string | undefined {
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    if (literalText(statement.moduleSpecifier as ts.Expression) !== '@fastify/rate-limit') continue
    return statement.importClause?.name?.text
  }
  return undefined
}

function callsNamed(root: ts.Node, names: readonly string[]): boolean {
  let found = false
  function visit(node: ts.Node): void {
    if (found) return
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      found = names.includes(node.expression.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return found
}

function isRateLimitEnforcedGuard(node: ts.IfStatement, child: ts.Node): boolean {
  const condition = node.expression
  return (
    node.thenStatement === child &&
    ts.isCallExpression(condition) &&
    ts.isIdentifier(condition.expression) &&
    condition.expression.text === RATE_LIMIT_ENFORCED_GUARD &&
    condition.arguments.length === 0
  )
}

/** True when the registration always runs in `fn` (bar the isRateLimitEnforced() test bypass). */
function isUnconditionalIn(registration: ts.CallExpression, fn: FunctionLike): boolean {
  let child: ts.Node = registration
  let current = registration.parent
  while (current && current !== fn) {
    const allowed =
      ts.isAwaitExpression(current) ||
      ts.isExpressionStatement(current) ||
      ts.isBlock(current) ||
      (ts.isIfStatement(current) && isRateLimitEnforcedGuard(current, child))
    if (!allowed) return false
    child = current
    current = current.parent
  }
  return current === fn
}

function isRateLimitRegistration(node: ts.CallExpression, rateLimitName: string | undefined) {
  if (ts.isIdentifier(node.expression)) return node.expression.text === 'registerIpRateLimit'
  if (!ts.isPropertyAccessExpression(node.expression)) return false
  if (node.expression.name.text !== 'register' || !rateLimitName) return false
  const plugin = node.arguments[0]
  return plugin !== undefined && ts.isIdentifier(plugin) && plugin.text === rateLimitName
}

function registrationIsGlobal(registration: ts.CallExpression): boolean {
  const options = registration.arguments[1]
  if (!options || !ts.isObjectLiteralExpression(options)) return true
  return objectProperty(options, 'global')?.kind !== ts.SyntaxKind.FalseKeyword
}

function routeRateLimitConfig(route: ParsedRoute): ts.Expression | undefined {
  const config = route.options ? objectProperty(route.options, 'config') : undefined
  return config && ts.isObjectLiteralExpression(config)
    ? objectProperty(config, 'rateLimit')
    : undefined
}

function hasPrecedingPluginRegistration(route: ParsedRoute): boolean {
  const ownConfig = routeRateLimitConfig(route)
  if (ownConfig?.kind === ts.SyntaxKind.FalseKeyword) return false
  const fn = enclosingFunction(route.call)
  if (!fn?.body) return false
  const rateLimitName = rateLimitImportName(route.call.getSourceFile())
  const hasOwnObjectConfig = ownConfig !== undefined && ts.isObjectLiteralExpression(ownConfig)
  let found = false
  function visit(node: ts.Node): void {
    if (found || node.getStart() >= route.call.getStart()) return
    if (
      ts.isCallExpression(node) &&
      isRateLimitRegistration(node, rateLimitName) &&
      isUnconditionalIn(node, fn as FunctionLike) &&
      (hasOwnObjectConfig || registrationIsGlobal(node))
    ) {
      found = true
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(fn.body)
  return found
}

function secureRouteKeepsRateLimit(route: ParsedRoute): boolean {
  if (route.registrar !== 'secureRoute') return false
  const security = route.options ? objectProperty(route.options, 'security') : undefined
  if (!security || !ts.isObjectLiteralExpression(security)) return true
  return objectProperty(security, 'rateLimit')?.kind !== ts.SyntaxKind.FalseKeyword
}

function routeHasIpRateLimit(route: ParsedRoute): boolean {
  if (secureRouteKeepsRateLimit(route)) return true
  if (callsNamed(route.options ?? route.call, MANUAL_IP_RATE_LIMITERS)) return true
  return route.registrar !== 'secureRoute' && hasPrecedingPluginRegistration(route)
}

/** Every reason `routeKey` (declared in `source`, mounted at `prefix`) fails its ip-rate-limit claim. */
function ipRateLimitViolations(source: string, routeKey: string, prefix = ''): string[] {
  const matches = parseRoutes(source).filter((route) => routeKeyFor(route, prefix) === routeKey)
  if (matches.length === 0) return [`${routeKey} claims ip-rate-limit but route not found`]
  return matches
    .filter((route) => !routeHasIpRateLimit(route))
    .map(
      (route) =>
        `${routeKey} claims ip-rate-limit but no registerIpRateLimit/register(rateLimit) precedes ` +
        `it in ${functionName(enclosingFunction(route.call))}, it is not a secureRoute (with ` +
        `rateLimit enabled), and its handler calls no MANUAL_IP_RATE_LIMITERS`
    )
}

function ipRateLimitClaimViolations(): string[] {
  const claimed = PUBLIC_ROUTE_EXEMPTIONS.filter((entry) =>
    (entry.compensatingControls as readonly string[]).includes(IP_RATE_LIMIT)
  ).map((entry) => entry.route)
  const productionRoutes = parsedProductionRoutes()
  return claimed.flatMap((routeKey) => {
    const declared = productionRoutes.find((entry) => entry.routeKey === routeKey)
    if (!declared) return [`${routeKey} claims ip-rate-limit but route not found`]
    const source = readFileSync(resolve(process.cwd(), 'src', declared.path), 'utf-8')
    return ipRateLimitViolations(source, routeKey, declared.prefix)
  })
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
    // Story 14.8: allowedRoles reordered to descending rank order (owner, admin) per
    // architecture.md's RBAC role-gate convention — same two roles authorized, order only.
    expect(source).toMatch(/allowedRoles:\s*\['owner', 'admin'\]/)
    expect(source).toMatch(/requireMfa:\s*true/)
  })

  it('does not import the test-only privileged route helper from production entrypoints', () => {
    const appSource = readFileSync(resolve(process.cwd(), 'src/app.ts'), 'utf-8')
    const mainSource = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf-8')

    expect(appSource).not.toContain('privileged-test-route')
    expect(mainSource).not.toContain('privileged-test-route')
  })
  it('every route that claims ip-rate-limit actually registers an IP limiter in its own scope', () => {
    expect(ipRateLimitClaimViolations()).toEqual([])
  })
})

// Story 43.8 AC-8: proves the checker above would have caught Finding 3, and rejects each way a
// lenient checker could pass a route whose IP limit can be off in production.
describe('ip-rate-limit audit checker (fixtures)', () => {
  const ROUTE_KEY = 'POST /cli-login'
  const IMPORTS = [
    "import rateLimit from '@fastify/rate-limit'",
    "import { registerIpRateLimit } from '../../lib/ip-rate-limit.js'",
  ].join('\n')

  function plugin(body: string): string {
    return `${IMPORTS}\nexport async function cliLoginRoutes(fastify) {\n${body}\n}\n`
  }

  const ROUTE_WITH_CONFIG = `
  withRouteTypeProvider(fastify).route({
    method: 'POST',
    url: '/cli-login',
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    handler: async () => ({}),
  })`
  const ROUTE_WITHOUT_CONFIG = `
  fastify.route({ method: 'POST', url: '/cli-login', handler: async () => ({}) })`
  const GUARDED_REGISTRATION = `
  if (isRateLimitEnforced()) {
    await fastify.register(rateLimit, { max: 60, timeWindow: '1 minute' })
  }`

  it('flags the pre-fix cli-login-routes.ts shape (config.rateLimit, no registration)', () => {
    const violations = ipRateLimitViolations(plugin(ROUTE_WITH_CONFIG), ROUTE_KEY)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toContain('POST /cli-login claims ip-rate-limit')
    expect(violations[0]).toContain('cliLoginRoutes')
  })

  it.each([
    [
      'config.rateLimit: false inside a registered scope',
      `${GUARDED_REGISTRATION}
  fastify.route({ method: 'POST', url: '/cli-login', config: { rateLimit: false }, handler: h })`,
    ],
    ['the registration placed after the route', `${ROUTE_WITH_CONFIG}\n${GUARDED_REGISTRATION}`],
    [
      'the registration inside a feature-flag conditional',
      `  if (env.FEATURE_X) {\n    await registerIpRateLimit(fastify, { max: 60 })\n  }\n${ROUTE_WITH_CONFIG}`,
    ],
    [
      'the registration inside a try block',
      `  try {\n    await registerIpRateLimit(fastify, { max: 60 })\n  } catch {}\n${ROUTE_WITH_CONFIG}`,
    ],
    [
      'the registration only mentioned in a comment and a string',
      `  // await registerIpRateLimit(fastify, { max: 60 })\n  const note = 'registerIpRateLimit(fastify)'\n${ROUTE_WITH_CONFIG}`,
    ],
    [
      'register(rateLimit, { global: false }) with a route lacking its own config',
      `  await fastify.register(rateLimit, { global: false })\n${ROUTE_WITHOUT_CONFIG}`,
    ],
    [
      'the registration inside a nested helper function',
      `  async function later() {\n    await registerIpRateLimit(fastify, { max: 60 })\n  }\n${ROUTE_WITH_CONFIG}`,
    ],
  ])('flags %s', (_label, body) => {
    expect(ipRateLimitViolations(plugin(body), ROUTE_KEY)).toHaveLength(1)
  })

  it.each([
    [
      'the real guarded register(rateLimit) shape',
      `${GUARDED_REGISTRATION}\n${ROUTE_WITHOUT_CONFIG}`,
    ],
    [
      'registerIpRateLimit as the first statement',
      `  await registerIpRateLimit(fastify, { max: 60 })\n${ROUTE_WITH_CONFIG}`,
    ],
    [
      'register(rateLimit, { global: false }) with a route carrying its own config',
      `  await fastify.register(rateLimit, { global: false })\n${ROUTE_WITH_CONFIG}`,
    ],
    [
      'a secureRoute that keeps its default rate limit',
      `  secureRoute(fastify, { method: 'POST', url: '/cli-login', security: { requireAuth: false }, handler: h })`,
    ],
    [
      'a raw route whose handler calls an allowlisted manual IP limiter',
      `  fastify.route({ method: 'POST', url: '/cli-login', handler: async (req, reply) => {\n    await enforceIpRateLimitAndNormalizeEmailBody(req, reply)\n  } })`,
    ],
  ])('accepts %s', (_label, body) => {
    expect(ipRateLimitViolations(plugin(body), ROUTE_KEY)).toEqual([])
  })

  it('flags a secureRoute that opts out with rateLimit: false', () => {
    const body = `  secureRoute(fastify, { method: 'POST', url: '/cli-login', security: { requireAuth: false, rateLimit: false }, handler: h })`
    expect(ipRateLimitViolations(plugin(body), ROUTE_KEY)).toHaveLength(1)
  })

  it('flags a claimed route that cannot be found (a rename cannot silently drop out)', () => {
    expect(ipRateLimitViolations(plugin(ROUTE_WITH_CONFIG), 'POST /renamed')).toEqual([
      'POST /renamed claims ip-rate-limit but route not found',
    ])
  })
})
