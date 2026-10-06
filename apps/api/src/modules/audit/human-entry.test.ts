import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tx } from '@project-vault/db'

const { computeAuditHmac, readAuditChainHead } = vi.hoisted(() => ({
  computeAuditHmac: vi.fn(() => 'hmac-stub'),
  readAuditChainHead: vi.fn(async () => ({ keyVersion: 1, previousEntryHmac: null })),
}))

vi.mock('./quota-gate.js', () => ({
  assertOrgMayWriteAuditGates: vi.fn(async () => undefined),
  estimateAuditEntrySizeBytes: vi.fn(() => 42),
}))
vi.mock('./write-entry.js', () => ({
  computeAuditHmac,
  readAuditChainHead,
  GENESIS_SENTINEL: 'genesis',
}))
vi.mock('../vault/key-service.js', () => ({ getAuditKey: vi.fn(() => Buffer.alloc(32)) }))

import { writeHumanAuditEntry } from './human-entry.js'

const ORG_ID = randomUUID()
const PROJECT_ID = randomUUID()

function createStubTx() {
  const values = vi.fn(async () => undefined)
  const tx = {
    execute: vi.fn(async () => undefined),
    insert: vi.fn(() => ({ values })),
  } as unknown as Tx
  return { tx, values }
}

const BASE = {
  orgId: ORG_ID,
  actorTokenId: null,
  eventType: 'project.export_created',
  resourceType: 'project',
  resourceId: PROJECT_ID,
  payload: { credentials: 1 },
}

describe('writeHumanAuditEntry projectId (Story 62-1 AC-5)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('writes project_id when projectId is provided', async () => {
    const { tx, values } = createStubTx()
    await writeHumanAuditEntry(tx, { ...BASE, projectId: PROJECT_ID })
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ projectId: PROJECT_ID }))
  })

  it('leaves project_id unset (NULL) when projectId is omitted', async () => {
    const { tx, values } = createStubTx()
    await writeHumanAuditEntry(tx, BASE)
    const [inserted] = values.mock.calls[0] as unknown as [Record<string, unknown>]
    expect(inserted['projectId'] ?? null).toBeNull()
  })

  it('keeps the HMAC input byte-identical with and without projectId (D1)', async () => {
    const first = createStubTx()
    await writeHumanAuditEntry(first.tx, BASE)
    const second = createStubTx()
    await writeHumanAuditEntry(second.tx, { ...BASE, projectId: PROJECT_ID })

    const [withoutInput] = computeAuditHmac.mock.calls[0] as unknown as [Record<string, unknown>]
    const [withInput] = computeAuditHmac.mock.calls[1] as unknown as [Record<string, unknown>]
    expect(JSON.stringify(withInput)).toBe(JSON.stringify(withoutInput))
    expect(Object.keys(withInput)).not.toContain('projectId')
  })
})
