import { beforeEach, describe, expect, it, vi } from 'vitest'

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

describe('writeHandoffSecurityEvent (Story 30.2 AC6.22/AC6.23)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    insertValues.mockResolvedValue(undefined)
  })

  it('writes to platform_security_events with no org_id, keyed by eventType', async () => {
    const { writeHandoffSecurityEvent } = await import('./handoff-security-events.js')
    await writeHandoffSecurityEvent({
      eventType: 'handoff_unknown_kid',
      meta: { ipAddress: '203.0.113.10', userAgent: 'vitest' },
      payload: { kid: 'unknown' },
    })
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'handoff_unknown_kid',
        payload: { kid: 'unknown' },
        ipAddress: '203.0.113.10',
        userAgent: 'vitest',
        keyVersion: 7,
      })
    )
    const call = insertValues.mock.calls[0]?.[0] as Record<string, unknown>
    expect(call).not.toHaveProperty('orgId')
  })

  it('AC6.22: the raw token never appears — payload is stripped of any token/rawToken key even if a caller mistakenly includes one', async () => {
    const { writeHandoffSecurityEvent } = await import('./handoff-security-events.js')
    await writeHandoffSecurityEvent({
      eventType: 'handoff_signature_invalid',
      meta: { ipAddress: null, userAgent: null },
      payload: {
        token: 'header.payload.signature',
        rawToken: 'x',
        safe: 'ok',
      } as unknown as Record<string, unknown>,
    })
    const call = insertValues.mock.calls[0]?.[0] as { payload: Record<string, unknown> }
    expect(JSON.stringify(call.payload)).not.toContain('header.payload.signature')
    expect(call.payload).toEqual({ safe: 'ok' })
  })

  it('swallows write failures (never throws to the caller)', async () => {
    db.transaction.mockRejectedValueOnce(new Error('db down'))
    const { writeHandoffSecurityEvent } = await import('./handoff-security-events.js')
    await expect(
      writeHandoffSecurityEvent({
        eventType: 'handoff_expired',
        meta: { ipAddress: null, userAgent: null },
      })
    ).resolves.toBeUndefined()
  })
})
