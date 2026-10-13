import { describe, expect, it, vi } from 'vitest'
import { registerExtension, type HostServices } from '@project-vault/extension-api'
import extension, {
  DENIED_CAPABILITY,
  GATE_URL,
  MOCK_DELEGATION_AUDIT_EXTENSION_NAME,
  WRITE_URL,
} from './index.js'

type Reply = { code: ReturnType<typeof vi.fn> }
type Handler = (ctx: unknown, req: unknown, reply: Reply) => Promise<unknown>

const ORG = 'org-1'
const EVENT_TYPE = 'ext.x.y'
const OCCURRED_AT = '2026-01-01T00:00:00.000Z'
const delegatedCtx = (orgId = ORG) => ({
  auth: {
    delegation: true,
    orgId,
    userId: 'u',
    sessionId: 'delegation',
    isPlatformOperator: false,
  },
  delegation: { orgId, actorId: 'sub-1' },
})

function build(write = vi.fn()) {
  const host = { auditEventSource: { writeAuditEvent: write } } as unknown as HostServices
  const hooks = extension.hooksFactory(host)
  const handler = (key: `POST ${string}`) =>
    Reflect.get(hooks.apiRoutes?.routes ?? {}, key)?.handler as unknown as Handler
  return { hooks, write, handler }
}

function call(handler: Handler, ctx: unknown, body: unknown) {
  const reply: Reply = { code: vi.fn() }
  return handler(ctx, { body }, reply).then((result) => ({ result, reply }))
}

describe('mock-delegation-audit-extension', () => {
  it('passes registerExtension() integrity checks and declares only data in the manifest', () => {
    const result = registerExtension(extension.manifest, (host) => extension.hooksFactory(host))
    expect(result.manifest.name).toBe(MOCK_DELEGATION_AUDIT_EXTENSION_NAME)
    expect(JSON.parse(JSON.stringify(extension.manifest))).toEqual(extension.manifest)
    expect(extension.manifest.capabilities).toEqual(['audit-event-source', 'capability-gate'])
  })

  it('declares a delegated write route with a historical policy, a capability and no default audit', () => {
    const add = extension.manifest.apiRoutes?.add ?? []
    const write = add.find((route) => route.url === WRITE_URL)
    expect(write?.method).toBe('POST')
    expect(write?.options?.security).toMatchObject({
      writeAuditEvent: false,
      capability: DENIED_CAPABILITY,
      delegation: { historicalActorPolicy: { maxAgeSeconds: 3600 } },
    })
    const gate = add.find((route) => route.url === GATE_URL)
    expect(gate?.options?.security).toMatchObject({ writeAuditEvent: false, delegation: true })
  })

  it('forwards the delegated org and the body fields to writeAuditEvent and returns the receipt', async () => {
    const receipt = { id: 'a', createdAt: OCCURRED_AT }
    const { handler, write } = build(vi.fn().mockResolvedValue(receipt))
    const { result } = await call(handler(`POST ${WRITE_URL}`), delegatedCtx(), {
      eventType: EVENT_TYPE,
      resourceType: 'thing',
      resourceId: 'r1',
      payload: { a: 1 },
      idempotencyKey: 'k-1',
      occurredAt: OCCURRED_AT,
      orgId: 'attacker-org',
    })
    expect(result).toEqual({ data: receipt })
    expect(write).toHaveBeenCalledWith({
      orgId: ORG,
      eventType: EVENT_TYPE,
      resourceType: 'thing',
      resourceId: 'r1',
      payload: { a: 1 },
      idempotencyKey: 'k-1',
      occurredAt: OCCURRED_AT,
    })
  })

  it.each([
    ['ExtensionAuditIdempotencyConflictError', 409],
    ['ExtensionAuditAttributionRejectedError', 422],
    ['SomethingElse', 500],
  ])('maps %s to HTTP %i with only its name and code', async (name, status) => {
    const failure = Object.assign(new Error('secret detail'), { name, code: 'actor_mismatch' })
    const { handler } = build(vi.fn().mockRejectedValue(failure))
    const { result, reply } = await call(handler(`POST ${WRITE_URL}`), delegatedCtx(), {
      eventType: EVENT_TYPE,
    })
    expect(reply.code).toHaveBeenCalledWith(status)
    expect(result).toEqual({ error: { name, code: 'actor_mismatch' } })
    expect(JSON.stringify(result)).not.toContain('secret detail')
  })

  it('refuses a context that is not delegated', async () => {
    const { handler, write } = build()
    const { reply } = await call(handler(`POST ${WRITE_URL}`), { auth: {} }, { eventType: 'e' })
    expect(reply.code).toHaveBeenCalledWith(500)
    expect(write).not.toHaveBeenCalled()
  })

  it('toggles the capability gate for the delegated org only', async () => {
    const { hooks, handler } = build()
    const gate = hooks.capabilityGate
    const check = (orgId: string, capability = DENIED_CAPABILITY) =>
      gate?.onCheckCapability({ orgId, capability } as never)
    expect(await check(ORG)).toEqual({ permitted: true })
    await call(handler(`POST ${GATE_URL}`), delegatedCtx(), { deny: true })
    expect(await check(ORG)).toMatchObject({ permitted: false, reasonCode: 'fixture_denied' })
    expect(await check('org-2')).toEqual({ permitted: true })
    expect(await check(ORG, 'monitoring.public-status-page')).toEqual({ permitted: true })
    await call(handler(`POST ${GATE_URL}`), delegatedCtx(), { deny: false })
    expect(await check(ORG)).toEqual({ permitted: true })
  })
})
