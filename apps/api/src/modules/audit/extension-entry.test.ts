import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tx } from '@project-vault/db'
import { SameTransactionAuditWriteError } from '../../lib/secure-route.js'

const { assertOrgMayWriteAuditGates, estimateAuditEntrySizeBytes } = vi.hoisted(() => ({
  assertOrgMayWriteAuditGates: vi.fn(),
  estimateAuditEntrySizeBytes: vi.fn(() => 42),
}))

const { currentAuditKeyVersion } = vi.hoisted(() => ({
  currentAuditKeyVersion: vi.fn(),
}))

const { computeAuditHmac, FIXTURE_HMAC } = vi.hoisted(() => {
  const FIXTURE_HMAC = 'fixture-hmac'
  return { computeAuditHmac: vi.fn(() => FIXTURE_HMAC), FIXTURE_HMAC }
})

// Story 1.25 AC-2: every write call site now looks up the chain tail before computing its hmac.
// Fixed to null (genesis) by default — individual tests override via mockResolvedValueOnce where
// the previous-hmac value itself is under test.
const { getPreviousEntryHmac, GENESIS_SENTINEL } = vi.hoisted(() => ({
  getPreviousEntryHmac: vi.fn(async () => null as string | null),
  GENESIS_SENTINEL: 'GENESIS',
}))

// jscpd fix (Story 1.25 CI-gate finding): extension-entry.ts now calls the consolidated
// `readAuditChainHead(tx, orgId)` helper instead of `currentAuditKeyVersion`/`getPreviousEntryHmac`
// directly. The mock here calls straight through to the already-mocked `currentAuditKeyVersion`/
// `getPreviousEntryHmac` (in the same order the real helper uses), so every existing test that
// drives those two mocks directly (mockResolvedValue, mockImplementation, call-order assertions)
// keeps working unchanged.
const { readAuditChainHead } = vi.hoisted(() => ({
  readAuditChainHead: vi.fn(async (tx: unknown, orgId: string) => ({
    keyVersion: await currentAuditKeyVersion(tx),
    previousEntryHmac: await getPreviousEntryHmac(tx, { table: 'audit_log_entries', orgId }),
  })),
}))

const { getAuditKey } = vi.hoisted(() => ({
  getAuditKey: vi.fn(() => Buffer.from('fixture-key')),
}))

vi.mock('./quota-gate.js', () => ({ assertOrgMayWriteAuditGates, estimateAuditEntrySizeBytes }))
vi.mock('./key-version.js', () => ({ currentAuditKeyVersion }))
vi.mock('./write-entry.js', () => ({
  computeAuditHmac,
  getPreviousEntryHmac,
  readAuditChainHead,
  GENESIS_SENTINEL,
}))
vi.mock('../vault/key-service.js', () => ({ getAuditKey }))

import { writeExtensionAuditEntry } from './extension-entry.js'

const FIXTURE_ROW = { id: 'row-1', createdAt: new Date('2026-08-17T00:00:00Z') }
const ORG_ID = 'org-1'
const EVENT_TYPE = 'ext.com.acme.fixture.thing_happened'
const EXTENSION_NAME = 'com.acme.fixture'
const PRIOR_ROW_HMAC = 'prior-row-hmac'

function createStubTx(): { tx: Tx; valuesSpy: ReturnType<typeof vi.fn> } {
  const returning = vi.fn(async () => [FIXTURE_ROW])
  const valuesSpy = vi.fn(() => ({ returning }))
  const tx = {
    execute: vi.fn(),
    insert: vi.fn(() => ({ values: valuesSpy })),
  } as unknown as Tx
  return { tx, valuesSpy }
}

describe('writeExtensionAuditEntry — AC-9/AC-11/AC-12/AC-13/AC-14', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    assertOrgMayWriteAuditGates.mockResolvedValue(undefined)
    currentAuditKeyVersion.mockResolvedValue(5)
    computeAuditHmac.mockReturnValue(FIXTURE_HMAC)
    getPreviousEntryHmac.mockResolvedValue(null)
  })

  it('happy path: inserts a row with actor_type=extension, folded payload, and returns id/createdAt', async () => {
    const { tx, valuesSpy } = createStubTx()

    const result = await writeExtensionAuditEntry(tx, {
      orgId: ORG_ID,
      eventType: EVENT_TYPE,
      resourceId: 'resource-1',
      resourceType: 'widget',
      payload: { foo: 'bar' },
      extensionName: EXTENSION_NAME,
    })

    expect(result).toEqual({ id: 'row-1', createdAt: FIXTURE_ROW.createdAt })
    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        actorTokenId: null,
        actorType: 'extension',
        eventType: EVENT_TYPE,
        payload: { foo: 'bar', extensionName: EXTENSION_NAME },
        keyVersion: 5,
        hmac: FIXTURE_HMAC,
        previousEntryHmac: null,
        ipAddress: null,
        userAgent: null,
        revealedFields: null,
      })
    )
  })

  it('Story 1.25 AC-2: threads the previous row hmac (or GENESIS_SENTINEL) into computeAuditHmac, and stores the real value (never the sentinel) in previousEntryHmac', async () => {
    const { tx, valuesSpy } = createStubTx()
    getPreviousEntryHmac.mockResolvedValue(PRIOR_ROW_HMAC)

    await writeExtensionAuditEntry(tx, {
      orgId: ORG_ID,
      eventType: EVENT_TYPE,
      payload: {},
      extensionName: EXTENSION_NAME,
    })

    expect(computeAuditHmac).toHaveBeenCalledWith(
      expect.objectContaining({ previousEntryHmac: PRIOR_ROW_HMAC }),
      expect.anything()
    )
    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ previousEntryHmac: PRIOR_ROW_HMAC })
    )
  })

  it('Story 1.25 AC-2: a genesis row (no previous row) folds GENESIS_SENTINEL into the digest but stores null', async () => {
    const { tx, valuesSpy } = createStubTx()
    getPreviousEntryHmac.mockResolvedValue(null)

    await writeExtensionAuditEntry(tx, {
      orgId: ORG_ID,
      eventType: EVENT_TYPE,
      payload: {},
      extensionName: EXTENSION_NAME,
    })

    expect(computeAuditHmac).toHaveBeenCalledWith(
      expect.objectContaining({ previousEntryHmac: GENESIS_SENTINEL }),
      expect.anything()
    )
    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ previousEntryHmac: null }))
  })

  it('AC-11 edge case: a caller-supplied payload.extensionName is overwritten by the host-assigned value', async () => {
    const { tx, valuesSpy } = createStubTx()

    await writeExtensionAuditEntry(tx, {
      orgId: ORG_ID,
      eventType: EVENT_TYPE,
      payload: { extensionName: 'spoofed-name', other: 1 },
      extensionName: 'com.acme.real',
    })

    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { extensionName: 'com.acme.real', other: 1 } })
    )
  })

  it('quota-gate propagation: refusal never reaches set_config/keyVersion/insert', async () => {
    const { tx, valuesSpy } = createStubTx()
    assertOrgMayWriteAuditGates.mockRejectedValue(
      new SameTransactionAuditWriteError('quota exhausted', 'audit_quota_exhausted')
    )

    await expect(
      writeExtensionAuditEntry(tx, {
        orgId: ORG_ID,
        eventType: EVENT_TYPE,
        payload: {},
        extensionName: EXTENSION_NAME,
      })
    ).rejects.toBeInstanceOf(SameTransactionAuditWriteError)

    expect(tx.execute).not.toHaveBeenCalled()
    expect(currentAuditKeyVersion).not.toHaveBeenCalled()
    expect(getPreviousEntryHmac).not.toHaveBeenCalled()
    expect(tx.insert).not.toHaveBeenCalled()
    expect(valuesSpy).not.toHaveBeenCalled()
  })

  it('AC-13: key version is read and threaded into both the hmac computation and the insert, strictly in order (set_config -> keyVersion -> previousHmac -> hmac -> insert)', async () => {
    const { tx } = createStubTx()
    const callOrder: string[] = []
    ;(tx.execute as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('set_config')
    })
    currentAuditKeyVersion.mockImplementation(async () => {
      callOrder.push('keyVersion')
      return 9
    })
    getPreviousEntryHmac.mockImplementation(async () => {
      callOrder.push('previousHmac')
      return null
    })
    computeAuditHmac.mockImplementation(() => {
      callOrder.push('hmac')
      return 'fixture-hmac-9'
    })
    ;(tx.insert as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push('insert')
      return {
        values: () => ({ returning: async () => [FIXTURE_ROW] }),
      }
    })

    await writeExtensionAuditEntry(tx, {
      orgId: ORG_ID,
      eventType: EVENT_TYPE,
      payload: {},
      extensionName: EXTENSION_NAME,
    })

    expect(callOrder).toEqual(['set_config', 'keyVersion', 'previousHmac', 'hmac', 'insert'])
    expect(computeAuditHmac).toHaveBeenCalledWith(
      expect.objectContaining({ keyVersion: 9 }),
      expect.anything()
    )
  })

  it('AC-22: never persists a non-null actorTokenId (extension actors have no user_identity_tokens row)', async () => {
    const { tx, valuesSpy } = createStubTx()

    await writeExtensionAuditEntry(tx, {
      orgId: ORG_ID,
      eventType: EVENT_TYPE,
      payload: {},
      extensionName: EXTENSION_NAME,
    })

    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ actorTokenId: null }))
  })
})
