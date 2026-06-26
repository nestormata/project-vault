import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { computeAuditHmac } from './write-entry.js'

describe('computeAuditHmac', () => {
  it('is deterministic regardless of object key insertion order', () => {
    const auditKey = Buffer.from('audit-key-for-test-audit-key-for-test')
    const first = computeAuditHmac(
      { eventType: 'USER_REGISTERED', payload: { b: 2, a: 1 } },
      auditKey
    )
    const second = computeAuditHmac(
      { payload: { a: 1, b: 2 }, eventType: 'USER_REGISTERED' },
      auditKey
    )

    expect(first).toBe(second)
  })

  it('uses HMAC-SHA256 over canonical sorted JSON', () => {
    const auditKey = Buffer.from('audit-key-for-test-audit-key-for-test')
    const hmac = computeAuditHmac({ z: 1, a: 'first' }, auditKey)
    const expected = createHmac('sha256', auditKey).update('{"a":"first","z":1}').digest('hex')

    expect(hmac).toBe(expected)
  })
})
