import { describe, expect, it, vi, beforeEach } from 'vitest'

const updateSetMock = vi.fn()
const whereMock = vi.fn()
const auditMock = vi.fn().mockResolvedValue(undefined)

let currentRow: Record<string, unknown> | undefined

vi.mock('@project-vault/db/schema', () => ({
  notificationQueue: { id: 'id', status: 'status', providerId: 'providerId' },
}))

vi.mock('../lib/audit-or-fail-closed.js', () => ({
  writeSystemAuditEntryOrFailClosed: (...args: unknown[]) => auditMock(...args),
}))

vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => ({ eq: args }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  currentRow = undefined
})

// Stub out a minimal tx object satisfying the select/update chain used by delivery-status.ts.
function buildTx() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          for: () => ({
            limit: () => Promise.resolve(currentRow ? [currentRow] : []),
          }),
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updateSetMock(values)
        return {
          where: () => {
            whereMock()
            return Promise.resolve([])
          },
        }
      },
    }),
  }
}

vi.mock('@project-vault/db', () => ({
  withOrg: async (_orgId: string, fn: (tx: unknown) => unknown) => fn(buildTx()),
}))

describe('applyDeliveryStatusUpdate', () => {
  it('returns not_found when the row does not exist', async () => {
    const { applyDeliveryStatusUpdate } = await import('./delivery-status.js')
    currentRow = undefined
    const result = await applyDeliveryStatusUpdate({
      notificationQueueId: 'missing',
      orgId: 'org-1',
      newStatus: 'delivered',
    })
    expect(result).toEqual({ outcome: 'not_found' })
  })

  it('applies a forward-progress transition and writes the audit event', async () => {
    const { applyDeliveryStatusUpdate } = await import('./delivery-status.js')
    currentRow = { id: 'row-1', status: 'sent', providerId: 'email' }
    const result = await applyDeliveryStatusUpdate({
      notificationQueueId: 'row-1',
      orgId: 'org-1',
      newStatus: 'delivered',
    })
    expect(result).toEqual({ outcome: 'applied' })
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'delivered' }))
    expect(auditMock).toHaveBeenCalledTimes(1)
  })

  it('discards a backward transition without writing or auditing', async () => {
    const { applyDeliveryStatusUpdate } = await import('./delivery-status.js')
    currentRow = { id: 'row-1', status: 'bounced', providerId: 'email' }
    const result = await applyDeliveryStatusUpdate({
      notificationQueueId: 'row-1',
      orgId: 'org-1',
      newStatus: 'delivered',
    })
    expect(result).toEqual({ outcome: 'discarded_backward', currentStatus: 'bounced' })
    expect(updateSetMock).not.toHaveBeenCalled()
    expect(auditMock).not.toHaveBeenCalled()
  })

  it('is a no-op for an idempotent same-status replay, without auditing', async () => {
    const { applyDeliveryStatusUpdate } = await import('./delivery-status.js')
    currentRow = { id: 'row-1', status: 'delivered', providerId: 'email' }
    const result = await applyDeliveryStatusUpdate({
      notificationQueueId: 'row-1',
      orgId: 'org-1',
      newStatus: 'delivered',
    })
    expect(result).toEqual({ outcome: 'idempotent_noop' })
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ lastEventAt: expect.any(Date) })
    )
    expect(auditMock).not.toHaveBeenCalled()
  })

  it('allows a same-rank transition between two terminal statuses', async () => {
    const { applyDeliveryStatusUpdate } = await import('./delivery-status.js')
    currentRow = { id: 'row-1', status: 'bounced', providerId: 'email' }
    const result = await applyDeliveryStatusUpdate({
      notificationQueueId: 'row-1',
      orgId: 'org-1',
      newStatus: 'suppressed',
    })
    expect(result).toEqual({ outcome: 'applied' })
  })

  it('never allows a terminal status to move back to pending or sent', async () => {
    const { applyDeliveryStatusUpdate } = await import('./delivery-status.js')
    for (const terminal of ['bounced', 'suppressed', 'failed'] as const) {
      currentRow = { id: 'row-1', status: terminal, providerId: 'email' }
      const result = await applyDeliveryStatusUpdate({
        notificationQueueId: 'row-1',
        orgId: 'org-1',
        newStatus: 'sent',
      })
      expect(result).toEqual({ outcome: 'discarded_backward', currentStatus: terminal })
    }
  })
})
