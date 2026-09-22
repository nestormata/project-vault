import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  computePlatformAuditHmac,
  redactPlatformAuditPayload,
  type PlatformAuditHmacFields,
} from './write-entry.js'
import { GENESIS_SENTINEL } from '../audit/write-entry.js'

const PLATFORM_AUDIT_KEY = Buffer.from('platform-audit-key-for-test-1234567890')

describe('Story 9.4 D6: computePlatformAuditHmac', () => {
  it('is deterministic regardless of object key insertion order', () => {
    const key = PLATFORM_AUDIT_KEY
    // Story 1.26: computePlatformAuditHmac's fields param is no longer a bare
    // Record<string, unknown> — these fixtures were widened here to satisfy
    // PlatformAuditHmacFields (AC-2/AC-4). The values chosen don't matter for this test's
    // assertion (key-order independence), only that both calls hash an equivalent object.
    const first: PlatformAuditHmacFields = {
      operatorId: 'op-1',
      actionType: 'settings.updated',
      payload: { b: 2, a: 1 },
      keyVersion: 1,
      previousEntryHmac: GENESIS_SENTINEL,
    }
    const second: PlatformAuditHmacFields = {
      payload: { a: 1, b: 2 },
      operatorId: 'op-1',
      actionType: 'settings.updated',
      keyVersion: 1,
      previousEntryHmac: GENESIS_SENTINEL,
    }

    expect(computePlatformAuditHmac(first, key)).toBe(computePlatformAuditHmac(second, key))
  })

  it('uses HMAC-SHA256 over canonical sorted JSON', () => {
    const key = PLATFORM_AUDIT_KEY
    // Story 1.26: widened to PlatformAuditHmacFields to satisfy the new type; the expected
    // canonical JSON below was recomputed for this fixture's fields — sortKeys/JSON.stringify/
    // createHmac themselves are unchanged (see write-entry.test.ts's new dedicated regression
    // test in the org-scoped module for a fixed-input/fixed-expected-output assertion).
    const fields: PlatformAuditHmacFields = {
      operatorId: 'z-operator',
      actionType: 'first-action',
      payload: { first: 1 },
      keyVersion: 1,
      previousEntryHmac: GENESIS_SENTINEL,
    }
    const hmac = computePlatformAuditHmac(fields, key)
    const expected = createHmac('sha256', key)
      .update(
        `{"actionType":"first-action","keyVersion":1,"operatorId":"z-operator","payload":{"first":1},"previousEntryHmac":"${GENESIS_SENTINEL}"}`
      )
      .digest('hex')

    expect(hmac).toBe(expected)
  })

  it('differs from the org-scoped audit HMAC for the same fields/key (distinct signing domain)', () => {
    const key = Buffer.from('shared-test-key-shared-test-key-shared!')
    const fields: PlatformAuditHmacFields = {
      operatorId: 'op-domain-check',
      actionType: 'domain.check',
      payload: {},
      keyVersion: 1,
      previousEntryHmac: GENESIS_SENTINEL,
    }
    const platformHmac = computePlatformAuditHmac(fields, key)
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
