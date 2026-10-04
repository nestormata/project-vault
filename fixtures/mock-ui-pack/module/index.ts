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
 * Story 68.10 — the MODULE PACK half of `@project-vault/mock-ui-pack`: the API surface a
 * CentralizeMe-shaped product registers on PV's router (M7), loaded by the REAL API through
 * `VAULT_EXTENSIONS_PACKAGE` in PV's own mechanism e2e. It uses the shipped
 * `@project-vault/extension-api` contract only.
 *
 * No back doors: nothing here bypasses authentication, tenancy or capability checks to make a test
 * pass. Data is read through the contract's `ctx.tx` (PV's own transaction, RLS applied), never a
 * client of the pack's own. The one fault knob (`MOCK_UI_PACK_BOOT_FAULT`) can only make the module
 * FAIL to boot, so the API's `VAULT_EXTENSIONS_REQUIRED` fail-closed path is provable; it never
 * opens anything. `apps/api/src/__tests__/mock-extension-not-in-production.test.ts` pins that the
 * knob appears only in the compose override and this package.
 *
 * Schemas come from this package's own `zod` dependency (3.25.x through `zod/v4`), the line
 * CentralizeMe's module pack uses. Sentinel strings are unique per case (`mock-ui-pack:m7-...`) so a
 * spec cannot pass on a neighbour's text. Not a template for a real extension.
 */

export const MOCK_UI_PACK_EXTENSION_NAME = 'test.mock-ui-pack'
/** The only environment key the module reads; set only in docker-compose.mock-ui-pack.yml. */
export const BOOT_FAULT_ENV = 'MOCK_UI_PACK_BOOT_FAULT'
/** The fault mode, read by its literal key (the one environment key this module reads). */
const bootFault = (): string | undefined => process.env['MOCK_UI_PACK_BOOT_FAULT']
/** The pack's own low explicit limit on `GET /api/v1/cm/limited`: N+1 calls give a 429 quickly. */
export const MOCK_UI_PACK_LOW_LIMIT = 1000
export const MOCK_UI_PACK_LIMIT_WINDOW_MS = 60_000
const MISSING_TARGET_URL = '/api/v1/mock-ui-pack-no-such-route'
const MISSING_TARGET_KEY = `GET ${MISSING_TARGET_URL}`
const PROJECT_URL = '/api/v1/projects/:projectId'
/** A PV route with its own low limit (20 per minute): the pack REPLACES its handler, PV's limiter stays. */
const MAINTENANCE_URL = '/api/v1/platform/maintenance-mode'
/** A manifest version above the host's: the host rejects it at negotiation (a load failure). */
const ABOVE_HOST_API_VERSION = '3.99.0'
const PROJECT_KEY = `GET ${PROJECT_URL}`
const DOCUMENTS_URL = '/api/v1/cm/documents'
const OWN_READ_CAPABILITY = 'cm.documents.read'
// A CM-only capability id (outside PV's set): it reaches this pack's gate, which denies it.
const OWN_WRITE_CAPABILITY = 'cm.documents.write'

const ProjectWithTilesSchema = z.object({
  data: z.looseObject({ id: z.string(), cmTiles: z.array(z.string()) }),
})
const ReplacedSchema = z.object({ data: z.object({ cm: z.string() }) })
const CliLoginSchema = z.object({ cm: z.string() })
const MissingSchema = z.object({ cm: z.string() })

const DOCUMENT_AUDIT = { eventType: 'cm.document.created', resourceType: 'cm_document' } as const

function declaration(): ApiRoutesDeclaration {
  const overrides: NonNullable<ApiRoutesDeclaration['override']> = [
    { method: 'GET', url: PROJECT_URL, mode: 'wrap', schema: 'extend' },
    { method: 'HEAD', url: PROJECT_URL, mode: 'replace' },
    // replace a PV route that has its own limiter: the pack declares none, so PV's number applies
    { method: 'GET', url: MAINTENANCE_URL, mode: 'replace', schema: 'replace' },
    // replace behind PV's own session/MFA/capability pipeline (no replaceSecurity)
    { method: 'GET', url: '/api/v1/users/me', mode: 'replace', schema: 'replace' },
    // loosen: reachable anonymously on purpose (recorded in the lock, never refused)
    {
      method: 'POST',
      url: '/api/v1/auth/cli-login',
      mode: 'replace',
      schema: 'replace',
      replaceSecurity: true,
      security: { requireAuth: false, rateLimit: false, writeAuditEvent: false },
    },
    // tighten: an admin with MFA only (recorded in the lock, never refused)
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
  ]
  if (bootFault() === 'missing-target') {
    // wraps a PV route that does not exist: the loader must reject it and, with
    // VAULT_EXTENSIONS_REQUIRED=true, the API must exit non-zero
    overrides.push({ method: 'GET', url: MISSING_TARGET_URL, mode: 'wrap', schema: 'extend' })
  }
  return {
    add: [
      {
        method: 'GET',
        url: DOCUMENTS_URL,
        options: { security: { minimumRole: 'member', writeAuditEvent: false } },
      },
      {
        method: 'POST',
        url: DOCUMENTS_URL,
        options: { security: { minimumRole: 'member', writeAuditEvent: DOCUMENT_AUDIT } },
      },
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
        url: '/api/v1/cm/gated',
        options: { security: { capability: OWN_WRITE_CAPABILITY, writeAuditEvent: false } },
      },
      {
        method: 'GET',
        url: '/api/v1/cm/own-capability',
        options: { security: { capability: OWN_READ_CAPABILITY, writeAuditEvent: false } },
      },
      {
        method: 'GET',
        url: '/api/v1/cm/limited',
        options: {
          security: {
            writeAuditEvent: false,
            rateLimit: { max: MOCK_UI_PACK_LOW_LIMIT, timeWindowMs: MOCK_UI_PACK_LIMIT_WINDOW_MS },
          },
        },
      },
    ],
    override: overrides,
  }
}

type Reply = { header: (name: string, value: string) => unknown; sent: boolean }
type Req = { body?: unknown; params?: Record<string, string> }
type SqlTx = { execute: (query: string) => Promise<unknown> }
type Next = () => Promise<unknown>

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  return Array.isArray(result) ? (result as Array<Record<string, unknown>>) : []
}

async function documents(ctx: ApiRouteContext) {
  const tx = ctx.tx as unknown as SqlTx
  const rows = rowsOf(await tx.execute('select id from projects order by id'))
  return {
    data: { orgId: ctx.auth.orgId, visibleProjectIds: rows.map((row) => String(row['id'])) },
  }
}

async function createDocument(_ctx: ApiRouteContext, req: Req) {
  const title = (req.body as { title?: unknown } | undefined)?.title
  return { data: { ok: true, title: typeof title === 'string' ? title : null } }
}

async function projectWrap(_ctx: ApiRouteContext, _req: Req, reply: Reply, next: Next) {
  const pv = await next()
  if (reply.sent) return pv
  const data = (pv as { data: Record<string, unknown> }).data
  return { data: { ...data, cmTiles: [`mock-ui-pack:m7-tile-${String(data['id'])}`] } }
}

function routes(): ApiRoutesHooks['routes'] {
  const table: ApiRoutesHooks['routes'] = {
    [`GET ${DOCUMENTS_URL}`]: { handler: documents },
    [`POST ${DOCUMENTS_URL}`]: { handler: createDocument },
    'POST /cm/webhooks/:provider': {
      handler: async (_ctx: object, req: Req) => ({ received: req.params?.['provider'] ?? null }),
    },
    'GET /api/v1/cm/mfa': { handler: async () => ({ data: 'mock-ui-pack:m7-mfa-ok' }) },
    'GET /api/v1/cm/gated': { handler: async () => ({ data: 'mock-ui-pack:m7-gated-ok' }) },
    'GET /api/v1/cm/own-capability': {
      handler: async () => ({ data: 'mock-ui-pack:m7-capability-ok' }),
    },
    'GET /api/v1/cm/limited': { handler: async () => ({ data: 'mock-ui-pack:m7-limited-ok' }) },
    [PROJECT_KEY]: { handler: projectWrap, schema: { response: { 200: ProjectWithTilesSchema } } },
    'HEAD /api/v1/projects/:projectId': {
      handler: async (_ctx: unknown, _req: Req, reply: Reply) => {
        reply.header('x-cm-head', 'explicit')
        return ''
      },
    },
    'GET /api/v1/users/me': {
      handler: async () => ({ data: { cm: 'mock-ui-pack:m7-replaced' } }),
      schema: { response: { 200: ReplacedSchema } },
    },
    [`GET ${MAINTENANCE_URL}`]: {
      handler: async () => ({ data: { cm: 'mock-ui-pack:m7-maintenance-replaced' } }),
      schema: { response: { 200: ReplacedSchema } },
    },
    'POST /api/v1/auth/cli-login': {
      handler: async () => ({ cm: 'mock-ui-pack:m7-loosened' }),
      schema: { response: { 200: CliLoginSchema } },
    },
    'GET /api/v1/capabilities': { handler: async () => ({ data: { capabilities: {} } }) },
  }
  return bootFault() === 'missing-target'
    ? {
        ...table,
        [MISSING_TARGET_KEY]: {
          handler: async () => ({ cm: 'never reached' }),
          schema: { response: { 200: MissingSchema } },
        },
      }
    : table
}

const extension = {
  get manifest(): ExtensionManifest {
    return {
      name: MOCK_UI_PACK_EXTENSION_NAME,
      apiVersion: bootFault() === 'above-host' ? ABOVE_HOST_API_VERSION : EXTENSION_API_VERSION,
      capabilities: ['capability-gate'],
      apiRoutes: declaration(),
    }
  },
  hooksFactory(): ExtensionHooks {
    return {
      apiRoutes: { routes: routes() },
      capabilityGate: {
        onCheckCapability: async ({ capability }) =>
          capability === OWN_WRITE_CAPABILITY
            ? {
                permitted: false,
                reasonCode: 'mock_ui_pack_denied',
                message: 'Denied by the mock pack.',
              }
            : { permitted: true },
      },
    }
  },
}

export default extension
