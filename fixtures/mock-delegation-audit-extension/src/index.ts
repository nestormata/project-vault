import {
  EXTENSION_API_VERSION,
  isApiRouteDelegatedContext,
  type ApiRouteReply,
  type ApiRoutesDeclaration,
  type AuditEventSourceWriteInput,
  type CapabilityDecision,
  type CapabilityGate,
  type CapabilityGateContext,
  type ExtensionHooks,
  type ExtensionManifest,
  type HostServices,
} from '@project-vault/extension-api'

/**
 * Story 71.5: a test fixture for the real-host proof of Epic 71 (journey j36). It declares ONE
 * delegated route that writes a host-attributed audit row from the request, and a tiny delegated
 * control route that flips the fixture's own capability gate for the calling org, so the journey
 * can prove a "capability disabled" denial on the real process without a second extension.
 *
 * The write route is a thin forwarder: every verification (assertion, body hash, operation,
 * replay burn, actor resolution, historical admission) is PV's pipeline before this handler runs,
 * and every attribution decision is PV's `writeAuditEvent`. The handler adds nothing PV could not
 * do for a real module pack; it only maps the host's typed errors to HTTP statuses and returns the
 * error class name and closed code, never a message.
 *
 * Not a template for a real extension, and never loaded by a production deployment (see the
 * README's Production-safety section).
 */
export const MOCK_DELEGATION_AUDIT_EXTENSION_NAME = 'test.mock-delegation-audit-extension'
export const WRITE_URL = '/api/v1/ext/mock-delegation/audit-events'
export const GATE_URL = '/api/v1/ext/mock-delegation/gate'
/** A capability id outside PV's own set: it reaches this fixture's gate unchanged. */
export const DENIED_CAPABILITY = 'ext.mock-delegation.audit-write'
/** The write route's historical window (one hour): the journey tests both sides of it. */
export const HISTORICAL_MAX_AGE_SECONDS = 3600

const manifest: ExtensionManifest = {
  name: MOCK_DELEGATION_AUDIT_EXTENSION_NAME,
  apiVersion: EXTENSION_API_VERSION,
  capabilities: ['audit-event-source', 'capability-gate'],
  apiRoutes: {
    add: [
      {
        method: 'POST',
        url: WRITE_URL,
        options: {
          security: {
            delegation: { historicalActorPolicy: { maxAgeSeconds: HISTORICAL_MAX_AGE_SECONDS } },
            writeAuditEvent: false,
            capability: DENIED_CAPABILITY,
          },
        },
      },
      {
        method: 'POST',
        url: GATE_URL,
        options: { security: { delegation: true, writeAuditEvent: false } },
      },
    ],
  } satisfies ApiRoutesDeclaration,
}

const HTTP_BY_ERROR_NAME = new Map<string, number>([
  ['ExtensionAuditIdempotencyConflictError', 409],
  ['ExtensionAuditAttributionRejectedError', 422],
])
const INTERNAL = 500

/** Orgs for which this fixture's gate currently denies `DENIED_CAPABILITY`. */
const deniedOrgIds = new Set<string>()

const capabilityGate: CapabilityGate = {
  async onCheckCapability(context: CapabilityGateContext): Promise<CapabilityDecision> {
    if (
      context.capability === DENIED_CAPABILITY &&
      context.orgId !== null &&
      deniedOrgIds.has(context.orgId)
    ) {
      return { permitted: false, reasonCode: 'fixture_denied', message: 'Denied by the fixture.' }
    }
    return { permitted: true }
  },
}

type WriteBody = Partial<AuditEventSourceWriteInput>

function stringField(body: object, name: string): string | undefined {
  const value: unknown = Reflect.get(body, name)
  return typeof value === 'string' ? value : undefined
}

/** Picks the known fields of the request body; `orgId` is never read from it. */
function writeInputFrom(body: unknown, orgId: string): AuditEventSourceWriteInput {
  const source = typeof body === 'object' && body !== null ? body : {}
  const payload: unknown = Reflect.get(source, 'payload')
  const picked: WriteBody = {
    eventType: stringField(source, 'eventType'),
    resourceType: stringField(source, 'resourceType'),
    resourceId: stringField(source, 'resourceId'),
    idempotencyKey: stringField(source, 'idempotencyKey'),
    actorId: stringField(source, 'actorId'),
    occurredAt: stringField(source, 'occurredAt'),
  }
  const defined = Object.fromEntries(
    Object.entries(picked).filter(([, value]) => value !== undefined)
  )
  return {
    ...defined,
    orgId,
    payload:
      typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {},
  } as AuditEventSourceWriteInput
}

function failure(reply: ApiRouteReply, error: unknown) {
  const name = error instanceof Error ? error.name : 'UnknownError'
  const code = (error as { code?: unknown } | null)?.code
  reply.code(HTTP_BY_ERROR_NAME.get(name) ?? INTERNAL)
  return { error: { name, code: typeof code === 'string' ? code : null } }
}

function hooksFactory(host?: HostServices): ExtensionHooks {
  const write = async (ctx: unknown, req: { body: unknown }, reply: ApiRouteReply) => {
    if (!isApiRouteDelegatedContext(ctx as never)) {
      reply.code(INTERNAL)
      return { error: { name: 'NotDelegatedContext', code: null } }
    }
    const { orgId } = (ctx as { delegation: { orgId: string } }).delegation
    try {
      const receipt = await host?.auditEventSource.writeAuditEvent(writeInputFrom(req.body, orgId))
      return { data: receipt }
    } catch (error) {
      return failure(reply, error)
    }
  }
  const gate = async (ctx: unknown, req: { body: unknown }, reply: ApiRouteReply) => {
    if (!isApiRouteDelegatedContext(ctx as never)) {
      reply.code(INTERNAL)
      return { error: { name: 'NotDelegatedContext', code: null } }
    }
    const { orgId } = (ctx as { delegation: { orgId: string } }).delegation
    const deny = (req.body as { deny?: unknown } | null)?.deny === true
    if (deny) deniedOrgIds.add(orgId)
    else deniedOrgIds.delete(orgId)
    return { data: { deny } }
  }
  return {
    capabilityGate,
    apiRoutes: {
      routes: {
        [`POST ${WRITE_URL}`]: { handler: write as never },
        [`POST ${GATE_URL}`]: { handler: gate as never },
      },
    },
  }
}

export default { manifest, hooksFactory }
