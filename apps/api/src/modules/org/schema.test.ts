import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  anomalousAccessPayloadSchema,
  failedAuthThresholdPayloadSchema,
  SecurityAlertDismissBodySchema,
} from './schema.js'

describe('failedAuthThresholdPayloadSchema', () => {
  it('accepts valid failed-auth threshold alert payloads', () => {
    expect(
      failedAuthThresholdPayloadSchema.parse({
        thresholdType: 'ip',
        thresholdCount: 10,
        windowSeconds: 300,
        attemptCount: 12,
        windowStart: '2026-06-27T10:00:00.000Z',
        windowEnd: '2026-06-27T10:05:00.000Z',
        ipAddress: '203.0.113.50',
      })
    ).toMatchObject({ thresholdType: 'ip' })
  })

  it('rejects malformed or overbroad payloads', () => {
    expect(() =>
      failedAuthThresholdPayloadSchema.parse({
        thresholdType: 'ip',
        thresholdCount: 10,
        windowSeconds: 300,
        attemptCount: 12,
        windowStart: 'not-a-date',
        windowEnd: '2026-06-27T10:05:00.000Z',
        ipAddress: '203.0.113.50',
        html: '<script>alert(1)</script>',
      })
    ).toThrow()
  })
})

describe('anomalousAccessPayloadSchema (ADR-6.2-06/6.2-07)', () => {
  const VALID = {
    actorTokenId: randomUUID(),
    revealedCount: 6,
    revealedCredentialIds: [randomUUID()],
    windowSeconds: 3600,
    windowStart: '2026-06-27T09:00:00.000Z',
    windowEnd: '2026-06-27T10:00:00.000Z',
  }

  it('accepts a valid anomalous-access alert payload', () => {
    expect(anomalousAccessPayloadSchema.parse(VALID)).toMatchObject({ revealedCount: 6 })
  })

  it('accepts a null actorTokenId', () => {
    expect(anomalousAccessPayloadSchema.parse({ ...VALID, actorTokenId: null })).toMatchObject({
      actorTokenId: null,
    })
  })

  it('caps revealedCredentialIds at 50 entries (adversarial-review finding 9)', () => {
    const tooMany = Array.from({ length: 51 }, () => randomUUID())
    expect(() =>
      anomalousAccessPayloadSchema.parse({ ...VALID, revealedCredentialIds: tooMany })
    ).toThrow()
  })

  it('rejects unknown extra keys', () => {
    expect(() => anomalousAccessPayloadSchema.parse({ ...VALID, extra: 'nope' })).toThrow()
  })
})

describe('SecurityAlertDismissBodySchema (AC 18)', () => {
  it('accepts an empty body (dismissalReason optional)', () => {
    expect(SecurityAlertDismissBodySchema.parse({})).toEqual({})
  })

  it('accepts a dismissalReason up to 1000 chars', () => {
    expect(SecurityAlertDismissBodySchema.parse({ dismissalReason: 'verified' })).toMatchObject({
      dismissalReason: 'verified',
    })
  })

  it('rejects a dismissalReason over 1000 chars', () => {
    expect(() =>
      SecurityAlertDismissBodySchema.parse({ dismissalReason: 'x'.repeat(1001) })
    ).toThrow()
  })
})
