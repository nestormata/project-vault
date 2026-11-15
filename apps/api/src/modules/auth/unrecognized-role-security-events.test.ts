import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ORG_ID = randomUUID()
const REQUEST_ID = randomUUID()
const USER_ID = randomUUID()
const ROUTE_KEY = 'PATCH /api/v1/service/organizations/:organizationId/members/:userId'

const insertValues = vi.fn()
const tx = {
  select: vi.fn(() => ({
    from: () => ({
      limit: async () => [{ auditKeyVersion: 7 }],
    }),
  })),
  insert: vi.fn(() => ({ values: insertValues })),
}
const db = {
  transaction: vi.fn(async (fn: (txArg: typeof tx) => Promise<unknown>) => fn(tx)),
}

vi.mock('@project-vault/db', () => ({ getDb: () => db }))
vi.mock('../vault/key-service.js', () => ({ getAuditKey: () => Buffer.alloc(32, 1) }))

describe('writeUnrecognizedRoleSecurityEvent (Story 73.5 D7)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    insertValues.mockResolvedValue(undefined)
  })

  it('writes unrecognized_role to platform_security_events with no org_id column', async () => {
    const { writeUnrecognizedRoleSecurityEvent } =
      await import('./unrecognized-role-security-events.js')
    await writeUnrecognizedRoleSecurityEvent({
      source: 'requested',
      role: 'superuser',
      orgId: ORG_ID,
      routeKey: ROUTE_KEY,
      requestId: REQUEST_ID,
      ipAddress: '203.0.113.10',
      userAgent: 'vitest',
    })
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'unrecognized_role',
        payload: {
          source: 'requested',
          role: 'superuser',
          orgId: ORG_ID,
          routeKey: ROUTE_KEY,
          requestId: REQUEST_ID,
        },
        ipAddress: '203.0.113.10',
        userAgent: 'vitest',
        keyVersion: 7,
      })
    )
    const call = insertValues.mock.calls[0]?.[0] as Record<string, unknown>
    expect(call).not.toHaveProperty('orgId')
  })

  it('hashes userId into subjectHash and omits the raw id from payload', async () => {
    const { writeUnrecognizedRoleSecurityEvent } =
      await import('./unrecognized-role-security-events.js')
    await writeUnrecognizedRoleSecurityEvent({
      source: 'stored',
      role: 'bogus',
      orgId: ORG_ID,
      userId: USER_ID,
    })
    const call = insertValues.mock.calls[0]?.[0] as {
      subjectHash: string | null
      payload: Record<string, unknown>
    }
    expect(call.subjectHash).toEqual(expect.any(String))
    expect(call.subjectHash).toHaveLength(64)
    expect(JSON.stringify(call.payload)).not.toContain(USER_ID)
    expect(call.payload).toMatchObject({ source: 'stored', role: 'bogus' })
  })

  it('swallows write failures', async () => {
    db.transaction.mockRejectedValueOnce(new Error('db down'))
    const { writeUnrecognizedRoleSecurityEvent } =
      await import('./unrecognized-role-security-events.js')
    await expect(
      writeUnrecognizedRoleSecurityEvent({ source: 'requested', role: 'owner' })
    ).resolves.toBeUndefined()
  })
})
