import { describe, expect, it } from 'vitest'
import { failedAuthThresholdPayloadSchema } from './schema.js'

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
