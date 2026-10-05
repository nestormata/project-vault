import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tx } from '@project-vault/db'

const { writeExtensionAuditEntry } = vi.hoisted(() => ({ writeExtensionAuditEntry: vi.fn() }))
vi.mock('./extension-entry.js', () => ({ writeExtensionAuditEntry }))

import {
  ExtensionAuditIdempotencyConflictError,
  ExtensionAuditIdempotencyKeyInvalidError,
  ExtensionAuditIdempotencyPayloadTooLargeError,
  ExtensionAuditIdempotencyRaceError,
  MAX_IDEMPOTENT_AUDIT_ENTRY_BYTES,
  assertValidIdempotencyKey,
  canonicalJson,
  computeContentFingerprint,
  writeIdempotentExtensionAuditEntry,
} from './extension-idempotency.js'

const ORIGINAL = { id: 'audit-1', createdAt: new Date('2026-10-02T00:00:00Z') }
const EXTENSION_NAME = 'com.acme.fixture'
const IDEMPOTENCY_KEY = 'cm-evt-123:v1'
const BASE = {
  orgId: 'org-1',
  eventType: 'ext.com.acme.fixture.thing_happened',
  resourceId: 'res-1',
  resourceType: 'widget',
  payload: { a: 1, b: { c: 2, d: 3 } },
  extensionName: EXTENSION_NAME,
  idempotencyKey: IDEMPOTENCY_KEY,
}

type StubOptions = {
  existing?: { fingerprint: string; auditId: string | null; createdAt: Date | null }
  insertReturns?: unknown[]
}

function createStubTx(options: StubOptions = {}): {
  tx: Tx
  execute: ReturnType<typeof vi.fn>
  values: ReturnType<typeof vi.fn>
} {
  const execute = vi.fn(async () => [])
  const limit = vi.fn(async () => (options.existing ? [options.existing] : []))
  const where = vi.fn(() => ({ limit }))
  const leftJoin = vi.fn(() => ({ where }))
  const from = vi.fn(() => ({ leftJoin }))
  const select = vi.fn(() => ({ from }))
  const returning = vi.fn(async () => options.insertReturns ?? [{ orgId: BASE.orgId }])
  const onConflictDoNothing = vi.fn(() => ({ returning }))
  const values = vi.fn(() => ({ onConflictDoNothing }))
  const insert = vi.fn(() => ({ values }))
  return { tx: { execute, select, insert } as unknown as Tx, execute, values }
}

beforeEach(() => {
  vi.clearAllMocks()
  writeExtensionAuditEntry.mockResolvedValue(ORIGINAL)
})

describe('assertValidIdempotencyKey — AC-1', () => {
  it.each(['cm-evt-123:v1', 'a', 'A.b_c-d:e', 'x'.repeat(128)])('accepts %s', (key) => {
    expect(() => assertValidIdempotencyKey(key)).not.toThrow()
  })

  it.each(['', 'x'.repeat(129), 'a b', 'a/b', 'café', 'a\nb', 42, null, {}, ['a']])(
    'rejects %j with the typed error',
    (key) => {
      expect(() => assertValidIdempotencyKey(key)).toThrow(ExtensionAuditIdempotencyKeyInvalidError)
    }
  )

  it('never echoes the rejected key value in the message', () => {
    try {
      assertValidIdempotencyKey('secret value/with slash')
    } catch (error) {
      expect((error as Error).message).not.toContain('secret value')
    }
  })
})

describe('computeContentFingerprint — Story 71.4 attribution (AC-5)', () => {
  const content = {
    eventType: 'ext.x.y',
    resourceType: 't',
    resourceId: 'r',
    projectId: 'p',
    payload: { a: 1, b: [1, 2] },
  }
  const attribution = (over: Record<string, unknown> = {}) => ({
    v: 1 as const,
    occurredAt: '2026-10-05T11:00:00.000Z',
    occurredAtSource: 'delegation_signed' as const,
    actor: {
      provider: 'workos',
      subject: 's',
      userId: 'u1',
      attestation: 'pv_verified' as const,
      reason: null,
    },
    delegatedBy: { kid: 'k1', issuer: 'i', assertionId: 'jti-1' },
    ...over,
  })

  it('keeps the pre-71.4 fingerprint for content with no attribution (golden hash)', () => {
    // sha256 of the literal canonical JSON the 71-1 fingerprint hashed; written independently of
    // `canonicalJson` so a change to either the key set or the order is caught.
    const literal =
      '{"eventType":"ext.x.y","payload":{"a":1,"b":[1,2]},"projectId":"p","resourceId":"r","resourceType":"t"}'
    expect(computeContentFingerprint(content)).toBe(
      createHash('sha256').update(literal).digest('hex')
    )
    expect(computeContentFingerprint({ ...content, attribution: undefined })).toBe(
      computeContentFingerprint(content)
    )
  })

  it('changes with the effective time, subject or provider', () => {
    const base = computeContentFingerprint({ ...content, attribution: attribution() })
    expect(base).not.toBe(computeContentFingerprint(content))
    const actor = attribution().actor
    for (const changed of [
      attribution({ occurredAt: '2026-10-05T11:00:01.000Z' }),
      attribution({ actor: { ...actor, subject: 'other' } }),
      attribution({ actor: { ...actor, provider: 'other' } }),
    ]) {
      expect(computeContentFingerprint({ ...content, attribution: changed })).not.toBe(base)
    }
  })

  it('does not change with delegatedBy, the assertion id, the kid, the reason, the user id or the attestation', () => {
    const base = computeContentFingerprint({ ...content, attribution: attribution() })
    const actor = attribution().actor
    const retry = attribution({
      delegatedBy: { kid: 'k2', issuer: 'other', assertionId: 'jti-2' },
      actor: {
        ...actor,
        userId: 'u2',
        reason: 'not_current_member',
        attestation: 'issuer_attested',
      },
    })
    expect(computeContentFingerprint({ ...content, attribution: retry })).toBe(base)
  })
})

describe('canonicalJson / computeContentFingerprint — AC-3', () => {
  it('sorts object keys recursively and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 2 } })).toBe(
      '{"a":{"c":2,"d":[3,{"y":2,"z":1}]},"b":1}'
    )
  })

  it('treats an undefined property as absent but null as distinct', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }))
    expect(canonicalJson({ a: 1, b: null })).not.toBe(canonicalJson({ a: 1 }))
  })

  it('fingerprint ignores payload key order and undefined-vs-absent optional fields', () => {
    const one = computeContentFingerprint({
      eventType: 'e',
      resourceType: undefined,
      resourceId: 'r',
      projectId: undefined,
      payload: { a: 1, b: 2 },
    })
    const two = computeContentFingerprint({
      eventType: 'e',
      resourceId: 'r',
      payload: { b: 2, a: 1 },
    })
    expect(one).toBe(two)
    expect(one).toMatch(/^[a-f0-9]{64}$/)
  })

  it('fingerprint changes with projectId, payload null-vs-absent and eventType', () => {
    const base = { eventType: 'e', payload: { a: 1 } }
    const fp = computeContentFingerprint(base)
    expect(computeContentFingerprint({ ...base, projectId: 'p' })).not.toBe(fp)
    expect(computeContentFingerprint({ ...base, payload: { a: 1, b: null } })).not.toBe(fp)
    expect(computeContentFingerprint({ ...base, eventType: 'f' })).not.toBe(fp)
  })
})

describe('writeIdempotentExtensionAuditEntry — AC-2/AC-3/AC-7b and failure modes', () => {
  it('takes the advisory lock first, writes the audit row, then records the key row (fingerprint only)', async () => {
    const { tx, execute, values } = createStubTx()
    const result = await writeIdempotentExtensionAuditEntry(tx, BASE)
    expect(result).toEqual({ ...ORIGINAL, deduped: false })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(writeExtensionAuditEntry).toHaveBeenCalledTimes(1)
    const lockOrder = execute.mock.invocationCallOrder[0] ?? 0
    const writeOrder = writeExtensionAuditEntry.mock.invocationCallOrder[0] ?? 0
    expect(lockOrder).toBeLessThan(writeOrder)
    const inserted = (values.mock.calls[0] as unknown as [Record<string, unknown>])[0]
    expect(inserted).toEqual({
      orgId: 'org-1',
      extensionName: EXTENSION_NAME,
      idempotencyKey: IDEMPOTENCY_KEY,
      contentFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      auditEntryId: 'audit-1',
    })
    expect(JSON.stringify(inserted)).not.toContain('"payload"')
  })

  it('forwards the content (without the idempotency key) to the existing write helper', async () => {
    const { tx } = createStubTx()
    await writeIdempotentExtensionAuditEntry(tx, BASE)
    expect(writeExtensionAuditEntry).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        orgId: 'org-1',
        eventType: BASE.eventType,
        extensionName: EXTENSION_NAME,
      })
    )
  })

  it('replay with identical content returns the original receipt and writes nothing', async () => {
    const fingerprint = computeContentFingerprint({
      eventType: BASE.eventType,
      resourceType: BASE.resourceType,
      resourceId: BASE.resourceId,
      payload: { b: { d: 3, c: 2 }, a: 1 },
    })
    const { tx, values } = createStubTx({
      existing: { fingerprint, auditId: ORIGINAL.id, createdAt: ORIGINAL.createdAt },
    })
    const result = await writeIdempotentExtensionAuditEntry(tx, BASE)
    expect(result).toEqual({ ...ORIGINAL, deduped: true })
    expect(writeExtensionAuditEntry).not.toHaveBeenCalled()
    expect(values).not.toHaveBeenCalled()
  })

  it('replay with different content throws the typed conflict and carries no stored content', async () => {
    const { tx } = createStubTx({
      existing: {
        fingerprint: 'f'.repeat(64),
        auditId: ORIGINAL.id,
        createdAt: ORIGINAL.createdAt,
      },
    })
    const error = await writeIdempotentExtensionAuditEntry(tx, BASE).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ExtensionAuditIdempotencyConflictError)
    expect(JSON.stringify(error)).not.toContain('f'.repeat(64))
    expect((error as Error).message).not.toContain('f'.repeat(64))
    expect(writeExtensionAuditEntry).not.toHaveBeenCalled()
  })

  it('a key row whose audit row is missing is an internal error, never a fabricated receipt', async () => {
    const fingerprint = computeContentFingerprint({
      eventType: BASE.eventType,
      resourceType: BASE.resourceType,
      resourceId: BASE.resourceId,
      payload: BASE.payload,
    })
    const { tx } = createStubTx({
      existing: { fingerprint, auditId: null, createdAt: null },
    })
    await expect(writeIdempotentExtensionAuditEntry(tx, BASE)).rejects.toThrow(
      /audit row is missing/
    )
  })

  it('a lost key-row insert race throws the internal race error so the audit row rolls back', async () => {
    const { tx } = createStubTx({ insertReturns: [] })
    await expect(writeIdempotentExtensionAuditEntry(tx, BASE)).rejects.toBeInstanceOf(
      ExtensionAuditIdempotencyRaceError
    )
  })

  it('AC-7b: rejects an oversize payload before locking or fingerprinting', async () => {
    const { tx, execute } = createStubTx()
    const huge = { blob: 'x'.repeat(MAX_IDEMPOTENT_AUDIT_ENTRY_BYTES) }
    await expect(
      writeIdempotentExtensionAuditEntry(tx, { ...BASE, payload: huge })
    ).rejects.toBeInstanceOf(ExtensionAuditIdempotencyPayloadTooLargeError)
    expect(execute).not.toHaveBeenCalled()
    expect(writeExtensionAuditEntry).not.toHaveBeenCalled()
  })

  it('propagates a first-write gate failure with no key row recorded', async () => {
    writeExtensionAuditEntry.mockRejectedValue(new Error('quota'))
    const { tx, values } = createStubTx()
    await expect(writeIdempotentExtensionAuditEntry(tx, BASE)).rejects.toThrow('quota')
    expect(values).not.toHaveBeenCalled()
  })
})
