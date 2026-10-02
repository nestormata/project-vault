import { z } from 'zod/v4'
import {
  EXTENSION_API_VERSION,
  type ApiRouteContext,
  type ApiRoutesDeclaration,
  type ApiRoutesHooks,
  type ExtensionHooks,
  type ExtensionManifest,
} from '@project-vault/extension-api'

/**
 * Story 68.8 — a test fixture that exercises M7 `apiRoutes` end to end through PV's real loader
 * and `createApp()`: an org-scoped added route, a mutating added route with PV's default audit, a
 * public added route outside `/api/v1`, a wrap of a PV `secureRoute` route that extends its
 * response schema, overrides of raw PV routes, and `replaceSecurity` declarations.
 *
 * Schemas come from THIS package's own `zod` dependency, pinned to the line CentralizeMe's module
 * pack uses (3.25.x, imported through its `zod/v4` subpath), so PV's compilers are proven against
 * a second Zod instance exactly like CM's (story Q5).
 *
 * Several boot scenarios share one package: tests pick one with `setApiRoutesScenario()` before
 * `createApp()` (the loader imports this module once per test file and reads `default.manifest`
 * and `default.hooksFactory` at load time). Not a template for a real extension.
 */

export type ApiRoutesScenario =
  | 'default'
  | 'missing-target'
  | 'collision'
  | 'bad-schema'
  | 'above-host'
  | 'never-refused'
  | 'old-pack'

let scenario: ApiRoutesScenario = 'default'

export function setApiRoutesScenario(next: ApiRoutesScenario): void {
  scenario = next
}

/** Call counters and observations the integration tests assert on. */
export const observed = {
  calls: new Map<string, number>(),
  lateNextErrors: [] as string[],
  hooksFactoryCalls: 0,
  contexts: [] as Array<{ route: string; ctxKeys: string[] }>,
}

export function resetObserved(): void {
  observed.calls.clear()
  observed.lateNextErrors.length = 0
  observed.hooksFactoryCalls = 0
  observed.contexts.length = 0
}

function count(route: string): void {
  observed.calls.set(route, (observed.calls.get(route) ?? 0) + 1)
}

type Reply = { header: (name: string, value: string) => unknown; sent: boolean }
type Req = { body?: unknown; params?: Record<string, string> }
type SqlTx = { execute: (query: string) => Promise<unknown> }
type Next = () => Promise<unknown>

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  return Array.isArray(result) ? (result as Array<Record<string, unknown>>) : []
}

function txOf(ctx: ApiRouteContext): SqlTx {
  return ctx.tx as unknown as SqlTx
}

const PROJECT_URL = '/api/v1/projects/:projectId'
const PROJECT_KEY = `GET ${PROJECT_URL}`
const DOCUMENTS_KEY = 'GET /api/v1/cm/documents'
const WRITE_KEY = 'POST /cm/x'
const WEBHOOK_KEY = 'POST /cm/webhooks/:provider'
const DASHBOARD_KEY = 'GET /api/v1/dashboard'

const ProjectWithTilesSchema = z.object({
  data: z.looseObject({ id: z.string(), cmTiles: z.array(z.string()) }),
})
// A PV capability id the fixture's own gate denies.
const GATED_PV_CAPABILITY = 'monitoring.public-status-page'
// Story 68.8 Q14: CM-only ids (outside PV's CapabilityId set) reach this gate unchanged; it permits
// the first and denies the second.
const CM_READ_CAPABILITY = 'cm.documents.read'
const CM_WRITE_CAPABILITY = 'cm.documents.write'
const DENIED_CAPABILITIES = new Set([GATED_PV_CAPABILITY, CM_WRITE_CAPABILITY])
const DashboardSchema = z.object({ cm: z.string() })
const SimpleSchema = z.object({ cm: z.boolean() })
const HealthWithCmSchema = z.looseObject({ status: z.string(), cm: z.string().optional() })

const defaultDeclaration: ApiRoutesDeclaration = {
  add: [
    {
      method: 'GET',
      url: '/api/v1/cm/documents',
      options: { security: { minimumRole: 'member', writeAuditEvent: false } },
    },
    { method: 'POST', url: '/cm/x' },
    {
      method: 'POST',
      url: '/cm/webhooks/:provider',
      options: { security: { requireAuth: false, writeAuditEvent: false } },
    },
    {
      method: 'GET',
      url: '/api/v1/cm/mfa',
      options: { security: { requireMfa: true, writeAuditEvent: false } },
    },
    {
      method: 'GET',
      url: '/api/v1/cm/operator',
      options: {
        security: { requirePlatformOperator: true, requireOrgScope: false, writeAuditEvent: false },
      },
    },
    {
      method: 'GET',
      url: '/api/v1/cm/gated',
      options: { security: { capability: GATED_PV_CAPABILITY, writeAuditEvent: false } },
    },
    {
      method: 'GET',
      url: '/api/v1/cm/own-capability',
      options: { security: { capability: CM_READ_CAPABILITY, writeAuditEvent: false } },
    },
    {
      method: 'GET',
      url: '/api/v1/cm/own-capability-denied',
      options: { security: { capability: CM_WRITE_CAPABILITY, writeAuditEvent: false } },
    },
  ],
  override: [
    { method: 'GET', url: PROJECT_URL, mode: 'wrap', schema: 'extend' },
    { method: 'HEAD', url: PROJECT_URL, mode: 'replace' },
    {
      method: 'GET',
      url: '/health',
      mode: 'wrap',
      schema: 'extend',
      hooks: { append: ['onSend'] },
    },
    { method: 'GET', url: '/api/v1/auth/login', mode: 'replace' },
    { method: 'POST', url: '/api/v1/vault/unseal', mode: 'replace', schema: 'replace' },
    {
      method: 'POST',
      url: '/api/v1/auth/cli-login',
      mode: 'replace',
      schema: 'replace',
      replaceSecurity: true,
      security: { requireAuth: false, rateLimit: false, writeAuditEvent: false },
    },
    { method: 'GET', url: '/api/v1/docs/yaml', mode: 'replace' },
    { method: 'GET', url: '/api/v1/status-pages/:token', mode: 'wrap' },
    { method: 'GET', url: '/api/v1/users/me', mode: 'wrap' },
    {
      method: 'GET',
      url: '/api/v1/dashboard',
      mode: 'replace',
      schema: 'replace',
      replaceSecurity: true,
      security: { requireAuth: false, rateLimit: false, writeAuditEvent: false },
    },
    {
      method: 'GET',
      url: '/api/v1/capabilities',
      mode: 'replace',
      replaceSecurity: true,
      security: {
        minimumRole: 'admin',
        requireMfa: true,
        requireOrgScope: false,
        writeAuditEvent: false,
      },
    },
  ],
}

async function documents(ctx: ApiRouteContext) {
  count(DOCUMENTS_KEY)
  const rows = rowsOf(await txOf(ctx).execute('select id from projects order by id'))
  return {
    data: { orgId: ctx.auth.orgId, visibleProjectIds: rows.map((row) => String(row['id'])) },
  }
}

async function write(ctx: ApiRouteContext, req: Req) {
  count(WRITE_KEY)
  await txOf(ctx).execute(
    "insert into security_alerts (org_id, alert_type, severity) values (current_setting('app.current_org_id')::uuid, 'cm.fixture_write', 'info')"
  )
  if ((req.body as { fail?: boolean } | undefined)?.fail) throw new Error('fixture write failed')
  return { data: { ok: true } }
}

async function projectWrap(ctx: ApiRouteContext, _req: Req, reply: Reply, next: Next) {
  count(PROJECT_KEY)
  observed.contexts.push({ route: PROJECT_KEY, ctxKeys: Object.keys(ctx).sort() })
  const pv = await next()
  if (reply.sent) return pv
  const data = (pv as { data: Record<string, unknown> }).data
  return { data: { ...data, cmTiles: [`tile-for-${String(data['id'])}`] } }
}

async function lateNext(_ctx: unknown, _req: Req, _reply: Reply, next: Next) {
  const result = await next()
  setTimeout(() => {
    next().then(
      () => observed.lateNextErrors.push('unexpectedly resolved'),
      (error: unknown) => observed.lateNextErrors.push((error as Error).message)
    )
  }, 5)
  return result
}

function defaultRoutes(): ApiRoutesHooks['routes'] {
  return {
    [DOCUMENTS_KEY]: { handler: documents },
    [WRITE_KEY]: { handler: write },
    [WEBHOOK_KEY]: {
      handler: async (ctx: object, req: Req) => {
        count(WEBHOOK_KEY)
        observed.contexts.push({ route: WEBHOOK_KEY, ctxKeys: Object.keys(ctx) })
        return { received: req.params?.['provider'] ?? null }
      },
    },
    'GET /api/v1/cm/mfa': { handler: async () => ({ data: 'mfa-ok' }) },
    'GET /api/v1/cm/operator': { handler: async () => ({ data: 'operator-ok' }) },
    'GET /api/v1/cm/gated': {
      handler: async () => {
        count('GET /api/v1/cm/gated')
        return { data: 'gated-ok' }
      },
    },
    [PROJECT_KEY]: {
      handler: projectWrap,
      schema: { response: { 200: ProjectWithTilesSchema } },
    },
    [`HEAD ${PROJECT_URL}`]: {
      handler: async (_ctx: unknown, _req: Req, reply: Reply) => {
        count(`HEAD ${PROJECT_URL}`)
        reply.header('x-cm-head', 'explicit')
        return ''
      },
    },
    'GET /health': {
      handler: async (_req: Req, reply: Reply, next: Next) => {
        reply.header('x-cm', '1')
        return next()
      },
      schema: { response: { 200: HealthWithCmSchema } },
      hooks: {
        onSend: async (_req: unknown, _reply: unknown, payload: unknown) =>
          typeof payload === 'string' && payload.startsWith('{')
            ? JSON.stringify({ ...(JSON.parse(payload) as object), cm: 'ok' })
            : payload,
      },
    },
    'GET /api/v1/auth/login': { handler: async () => ({ cm: 'login-get' }) },
    'POST /api/v1/vault/unseal': {
      schema: { response: { 200: z.object({ cm: z.string() }) } },
      handler: async () => ({ cm: 'unseal' }),
    },
    'POST /api/v1/auth/cli-login': {
      schema: { response: { 200: z.object({ cm: z.string() }) } },
      handler: async () => ({ cm: 'cli' }),
    },
    'GET /api/v1/docs/yaml': { handler: async () => 'cm: yaml' },
    'GET /api/v1/status-pages/:token': {
      handler: async (ctx: object, _req: Req, _reply: Reply, next: Next) => {
        observed.contexts.push({
          route: 'GET /api/v1/status-pages/:token',
          ctxKeys: Object.keys(ctx),
        })
        return next()
      },
    },
    'GET /api/v1/users/me': { handler: lateNext },
    'GET /api/v1/cm/own-capability': {
      handler: async () => {
        count('GET /api/v1/cm/own-capability')
        return { data: 'cm-capability-ok' }
      },
    },
    'GET /api/v1/cm/own-capability-denied': {
      handler: async () => {
        count('GET /api/v1/cm/own-capability-denied')
        return { data: 'never reached' }
      },
    },
    [DASHBOARD_KEY]: {
      schema: { response: { 200: DashboardSchema } },
      handler: async (ctx: object) => {
        count(DASHBOARD_KEY)
        observed.contexts.push({ route: DASHBOARD_KEY, ctxKeys: Object.keys(ctx) })
        return { cm: 'dashboard' }
      },
    },
    'GET /api/v1/capabilities': { handler: async () => ({ capabilities: {} }) },
  }
}

type ScenarioDefinition = {
  manifest: ExtensionManifest
  hooks: () => ExtensionHooks
}

function implementationsFor(declaration: ApiRoutesDeclaration): ApiRoutesHooks['routes'] {
  const entries = [...(declaration.add ?? []), ...(declaration.override ?? [])]
  return Object.fromEntries(
    entries.map((entry) => [
      `${entry.method} ${entry.url}`,
      { handler: async () => ({ cm: true }), schema: { response: { 200: SimpleSchema } } },
    ])
  )
}

function simple(
  declaration: ApiRoutesDeclaration,
  apiVersion = EXTENSION_API_VERSION
): ScenarioDefinition {
  return {
    manifest: {
      name: 'test.mock-api-routes-extension',
      apiVersion,
      capabilities: [],
      apiRoutes: declaration,
    },
    hooks: () => ({ apiRoutes: { routes: implementationsFor(declaration) } }),
  }
}

const NAME = 'test.mock-api-routes-extension'

function scenarios(): Record<ApiRoutesScenario, ScenarioDefinition> {
  return {
    default: {
      manifest: {
        name: NAME,
        apiVersion: EXTENSION_API_VERSION,
        capabilities: ['capability-gate', 'auth-provider'],
        apiRoutes: defaultDeclaration,
      },
      hooks: () => ({
        apiRoutes: { routes: defaultRoutes() },
        authStrategy: {
          onAuthenticate: async () => ({
            externalSubject: 'fixture-subject',
            providerName: 'mock-api-routes',
          }),
        },
        capabilityGate: {
          onCheckCapability: async ({ capability }) =>
            DENIED_CAPABILITIES.has(capability)
              ? { permitted: false, reasonCode: 'fixture_denied', message: 'Denied by fixture.' }
              : { permitted: true },
        },
      }),
    },
    'missing-target': simple({
      override: [
        { method: 'PATCH', url: '/api/v1/nope', mode: 'replace' },
        { method: 'GET', url: '/api/v1/projects/:id', mode: 'replace' },
      ],
    }),
    collision: simple({ add: [{ method: 'GET', url: '/api/v1/projects' }] }),
    'bad-schema': {
      manifest: {
        name: NAME,
        apiVersion: EXTENSION_API_VERSION,
        capabilities: [],
        apiRoutes: {
          override: [{ method: 'GET', url: PROJECT_URL, mode: 'wrap', schema: 'extend' }],
        },
      },
      hooks: () => ({
        apiRoutes: {
          routes: {
            [PROJECT_KEY]: {
              handler: async () => ({}),
              schema: { response: { 200: { type: 'object' } } },
            },
          },
        },
      }),
    },
    'above-host': simple({ add: [{ method: 'GET', url: '/cm/above-host' }] }, '3.99.0'),
    'never-refused': simple({
      override: [
        {
          method: 'POST',
          url: '/api/v1/auth/login',
          mode: 'replace',
          schema: 'replace',
          replaceSecurity: true,
          security: { requireAuth: false, rateLimit: false, writeAuditEvent: false },
        },
        {
          method: 'GET',
          url: '/api/v1/admin/settings',
          mode: 'replace',
          schema: 'replace',
          replaceSecurity: true,
          security: { requireAuth: false, rateLimit: false, writeAuditEvent: false },
        },
      ],
    }),
    'old-pack': {
      manifest: { name: NAME, apiVersion: '3.25.0', capabilities: [] },
      hooks: () => ({}),
    },
  }
}

function current(): ScenarioDefinition {
  const definition = new Map(Object.entries(scenarios())).get(scenario)
  if (!definition) throw new Error(`unknown apiRoutes fixture scenario: ${scenario}`)
  return definition
}

const extension = {
  get manifest(): ExtensionManifest {
    return current().manifest
  },
  hooksFactory(): ExtensionHooks {
    observed.hooksFactoryCalls += 1
    return current().hooks()
  },
}

export default extension
