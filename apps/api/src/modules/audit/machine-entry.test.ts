import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tx } from '@project-vault/db'

const { shouldSuppressAuditWrite, logAuditWriteSuspended } = vi.hoisted(() => ({
  shouldSuppressAuditWrite: vi.fn(),
  logAuditWriteSuspended: vi.fn(),
}))

vi.mock('./maintenance-mode.js', () => ({
  shouldSuppressAuditWrite,
  logAuditWriteSuspended,
}))

import { writeMachineAuditEntry, writeSystemAuditEntry } from './machine-entry.js'

function createStubTx(): Tx {
  return {
    execute: vi.fn(),
    insert: vi.fn(),
  } as unknown as Tx
}

describe('machine-entry maintenance-mode suppression', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    shouldSuppressAuditWrite.mockResolvedValue(true)
  })

  it('writeMachineAuditEntry short-circuits without touching tx when suppressed', async () => {
    const tx = createStubTx()

    await expect(
      writeMachineAuditEntry(tx, {
        orgId: 'org-1',
        eventType: 'machine.something.happened',
        payload: {},
        machineUserId: 'machine-1',
        keyId: 'key-1',
      })
    ).resolves.toBeUndefined()

    expect(logAuditWriteSuspended).toHaveBeenCalledWith('machine.something.happened', 'org-1')
    expect(tx.execute).not.toHaveBeenCalled()
    expect(tx.insert).not.toHaveBeenCalled()
  })

  it('writeSystemAuditEntry short-circuits without touching tx when suppressed', async () => {
    const tx = createStubTx()

    await expect(
      writeSystemAuditEntry(tx, {
        orgId: 'org-2',
        eventType: 'system.something.happened',
        payload: {},
      })
    ).resolves.toBeUndefined()

    expect(logAuditWriteSuspended).toHaveBeenCalledWith('system.something.happened', 'org-2')
    expect(tx.execute).not.toHaveBeenCalled()
    expect(tx.insert).not.toHaveBeenCalled()
  })
})
