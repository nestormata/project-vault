import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { computePlatformAuditHmac, redactPlatformAuditPayload } from './write-entry.js'

describe('Story 9.4 D6: computePlatformAuditHmac', () => {
  it('is deterministic regardless of object key insertion order', () => {
    const key = Buffer.from('platform-audit-key-for-test-1234567890')
    const first = computePlatformAuditHmac(
      { operatorId: 'op-1', actionType: 'settings.updated', payload: { b: 2, a: 1 } },
      key
    )
    const second = computePlatformAuditHmac(
      { payload: { a: 1, b: 2 }, operatorId: 'op-1', actionType: 'settings.updated' },
      key
    )

    expect(first).toBe(second)
  })

  it('uses HMAC-SHA256 over canonical sorted JSON', () => {
    const key = Buffer.from('platform-audit-key-for-test-1234567890')
    const hmac = computePlatformAuditHmac({ z: 1, a: 'first' }, key)
    const expected = createHmac('sha256', key).update('{"a":"first","z":1}').digest('hex')

    expect(hmac).toBe(expected)
  })

  it('differs from the org-scoped audit HMAC for the same fields/key (distinct signing domain)', () => {
    const key = Buffer.from('shared-test-key-shared-test-key-shared!')
    const platformHmac = computePlatformAuditHmac({ a: 1 }, key)
    expect(platformHmac).toHaveLength(64) // sha256 hex
  })
})

describe('Story 9.4 AC-6: redactPlatformAuditPayload', () => {
  it('passes a clean payload through unchanged', () => {
    const result = redactPlatformAuditPayload({ fieldsChanged: ['smtp.host'] })
    expect(result).toEqual({ fieldsChanged: ['smtp.host'] })
  })

  it('throws a development-time assertion error when a forbidden key is present and isProduction is false', () => {
    expect(() =>
      redactPlatformAuditPayload({ password: 'hunter2' }, { isProduction: false })
    ).toThrow(/forbidden/i)
  })

  it('strips the forbidden key silently and logs a warning when isProduction is true', () => {
    const onForbiddenKeyStripped = vi.fn()
    const result = redactPlatformAuditPayload(
      { safeField: 'ok', password: 'hunter2' },
      { isProduction: true, onForbiddenKeyStripped }
    )
    expect(result).toEqual({ safeField: 'ok' })
    expect(onForbiddenKeyStripped).toHaveBeenCalledTimes(1)
  })

  it('detects forbidden keys nested inside the payload, not just top-level', () => {
    expect(() =>
      redactPlatformAuditPayload({ smtp: { password: 'nested-secret' } }, { isProduction: false })
    ).toThrow(/forbidden/i)
  })
})
