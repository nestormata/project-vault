import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tx } from '@project-vault/db'
import { SameTransactionAuditWriteError } from '../../lib/secure-route.js'

const { assertOrgMayWriteAuditGates, estimateAuditEntrySizeBytes } = vi.hoisted(() => ({
  assertOrgMayWriteAuditGates: vi.fn(),
  estimateAuditEntrySizeBytes: vi.fn(() => 42),
}))

vi.mock('./quota-gate.js', () => ({
  assertOrgMayWriteAuditGates,
  estimateAuditEntrySizeBytes,
}))

import { writeMachineAuditEntry, writeSystemAuditEntry } from './machine-entry.js'

const MACHINE_EVENT_TYPE = 'machine.something.happened'
const SYSTEM_EVENT_TYPE = 'system.something.happened'

function createStubTx(): Tx {
  return {
    execute: vi.fn(),
    insert: vi.fn(),
  } as unknown as Tx
}

// Story 22.1 AC-10/AC-13: shouldSuppressAuditWrite/logAuditWriteSuspended are deleted — there is
// no "skip this write" return value any more. The gate primitive either returns (admitted) or
// throws SameTransactionAuditWriteError (refused), which propagates and rolls back the caller's
// transaction rather than silently short-circuiting to a successful no-op.
describe('machine-entry / quota-gate wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    assertOrgMayWriteAuditGates.mockRejectedValue(
      new SameTransactionAuditWriteError('quota exhausted', 'audit_quota_exhausted')
    )
  })

  it('writeMachineAuditEntry propagates a gate refusal and never reaches the insert', async () => {
    const tx = createStubTx()

    await expect(
      writeMachineAuditEntry(tx, {
        orgId: 'org-1',
        eventType: MACHINE_EVENT_TYPE,
        payload: {},
        machineUserId: 'machine-1',
        keyId: 'key-1',
      })
    ).rejects.toBeInstanceOf(SameTransactionAuditWriteError)

    expect(assertOrgMayWriteAuditGates).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ orgId: 'org-1', eventType: MACHINE_EVENT_TYPE })
    )
    expect(tx.execute).not.toHaveBeenCalled()
    expect(tx.insert).not.toHaveBeenCalled()
  })

  it('writeSystemAuditEntry propagates a gate refusal and never reaches the insert', async () => {
    const tx = createStubTx()

    await expect(
      writeSystemAuditEntry(tx, {
        orgId: 'org-2',
        eventType: SYSTEM_EVENT_TYPE,
        payload: {},
      })
    ).rejects.toBeInstanceOf(SameTransactionAuditWriteError)

    expect(assertOrgMayWriteAuditGates).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ orgId: 'org-2', eventType: SYSTEM_EVENT_TYPE })
    )
    expect(tx.execute).not.toHaveBeenCalled()
    expect(tx.insert).not.toHaveBeenCalled()
  })
})
