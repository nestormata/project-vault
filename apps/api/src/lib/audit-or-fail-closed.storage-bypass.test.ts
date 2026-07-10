import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tx } from '@project-vault/db'

const mocks = vi.hoisted(() => ({
  writePlatformAuditEntry: vi.fn(),
  queuePendingEntry: vi.fn(),
  isMaintenanceModeActive: vi.fn(),
}))

vi.mock('../modules/platform-audit/write-entry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../modules/platform-audit/write-entry.js')>()
  return {
    ...actual,
    writePlatformAuditEntry: mocks.writePlatformAuditEntry,
  }
})

vi.mock('../modules/platform-audit/maintenance-mode.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../modules/platform-audit/maintenance-mode.js')>()
  return {
    ...actual,
    isMaintenanceModeActive: mocks.isMaintenanceModeActive,
    queuePendingEntry: mocks.queuePendingEntry,
  }
})

const { writePlatformAuditEntryOrFailClosed } = await import('./audit-or-fail-closed.js')

const tx = {
  transaction: vi.fn(async (callback: (savepointTx: Tx) => Promise<void>) => callback(tx as Tx)),
} as unknown as Tx

describe('Story 9.8 AC-T3: storage errors use the active-maintenance bypass', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isMaintenanceModeActive.mockResolvedValue(true)
    mocks.queuePendingEntry.mockResolvedValue(undefined)
  })

  it.each([
    Object.assign(new Error('query failed'), {
      cause: Object.assign(new Error('connection failed'), { code: '08006' }),
    }),
    Object.assign(new Error('connection failed'), { code: 'ECONNREFUSED' }),
  ])('queues a classified storage failure', async (failure) => {
    mocks.writePlatformAuditEntry.mockRejectedValue(failure)

    await expect(
      writePlatformAuditEntryOrFailClosed(tx, {
        operatorId: randomUUID(),
        actionType: 'settings.updated',
        payload: { fieldsChanged: ['smtp.host'] },
      })
    ).resolves.toBeUndefined()

    expect(mocks.queuePendingEntry).toHaveBeenCalledOnce()
    expect(mocks.queuePendingEntry).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ payload: { fieldsChanged: ['smtp.host'] } })
    )
  })
})
