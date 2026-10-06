import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { DelegationSnapshot } from '../../lib/request-context.js'
import {
  ExtensionAuditAttributionRejectedError,
  PV_ATTRIBUTION_KEY,
  attributionFingerprintPart,
  resolveAttribution,
  type AttributionRejectCode,
} from './extension-attribution.js'

/** Story 71.4 AC-4: the pure attribution builder and validators, with an injected clock. */
const NOW = Date.parse('2026-10-05T12:00:00.000Z')
const ORG = randomUUID()
const OTHER_ORG = randomUUID()
const USER_ID = randomUUID()
const OCC_SECONDS = Math.floor(NOW / 1000) - 3600
const OCC_ISO = new Date(OCC_SECONDS * 1000).toISOString()

function snapshot(over: Partial<DelegationSnapshot> = {}): DelegationSnapshot {
  return {
    orgId: ORG,
    actor: {
      provider: 'workos',
      subject: 'user_01EXAMPLE',
      userId: USER_ID,
      attestation: 'pv_verified',
      reason: null,
    },
    delegatedBy: { kid: 'cm-deleg-1', issuer: 'https://issuer.example', assertionId: 'jti-1' },
    ...over,
  }
}

type Input = Parameters<typeof resolveAttribution>[0]
const base = (over: Partial<Input> = {}): Input => ({ orgId: ORG, payload: {}, ...over })

function codeOf(input: Input, ambient?: DelegationSnapshot): AttributionRejectCode {
  try {
    resolveAttribution(input, ambient, NOW)
  } catch (error) {
    expect(error).toBeInstanceOf(ExtensionAuditAttributionRejectedError)
    const typed = error as ExtensionAuditAttributionRejectedError
    expect(typed.retryable).toBe(false)
    expect(typed.message).not.toContain('user_01EXAMPLE')
    return typed.code
  }
  throw new Error('expected a rejection')
}

describe('resolveAttribution: what is stored', () => {
  it('stores nothing at all without a delegated request and without occurredAt (D7)', () => {
    expect(resolveAttribution(base(), undefined, NOW)).toBeUndefined()
  })

  it('attributes a linked member on a delegated request and defaults occurredAt to the signed occ', () => {
    const result = resolveAttribution(base(), snapshot({ occurredAtSeconds: OCC_SECONDS }), NOW)
    expect(result).toEqual({
      v: 1,
      occurredAt: OCC_ISO,
      occurredAtSource: 'delegation_signed',
      actor: {
        provider: 'workos',
        subject: 'user_01EXAMPLE',
        userId: USER_ID,
        attestation: 'pv_verified',
        reason: null,
      },
      delegatedBy: { kid: 'cm-deleg-1', issuer: 'https://issuer.example', assertionId: 'jti-1' },
    })
  })

  it('attributes without a time when the assertion has no occ and none is given', () => {
    const result = resolveAttribution(base(), snapshot(), NOW)
    expect(result).not.toHaveProperty('occurredAt')
    expect(result).not.toHaveProperty('occurredAtSource')
    expect(result?.actor?.subject).toBe('user_01EXAMPLE')
  })

  it('records an unlinked actor with no user id and an issuer-attested reason', () => {
    const unlinked = snapshot({
      actor: {
        provider: 'workos',
        subject: 's',
        userId: null,
        attestation: 'issuer_attested',
        reason: 'unlinked',
      },
    })
    expect(resolveAttribution(base(), unlinked, NOW)?.actor).toEqual({
      provider: 'workos',
      subject: 's',
      userId: null,
      attestation: 'issuer_attested',
      reason: 'unlinked',
    })
  })

  it('stores an extension-declared time with source extension and no actor outside a delegated request', () => {
    const result = resolveAttribution(base({ occurredAt: '2026-10-05T11:00:00Z' }), undefined, NOW)
    expect(result).toEqual({
      v: 1,
      occurredAt: '2026-10-05T11:00:00.000Z',
      occurredAtSource: 'extension',
    })
  })

  it('accepts a matching actorId and a matching occurredAt (to the second)', () => {
    const input = base({ actorId: 'user_01EXAMPLE', occurredAt: OCC_ISO.replace('.000Z', '.009Z') })
    const result = resolveAttribution(input, snapshot({ occurredAtSeconds: OCC_SECONDS }), NOW)
    expect(result?.occurredAtSource).toBe('delegation_signed')
    expect(result?.occurredAt).toBe(OCC_ISO.replace('.000Z', '.009Z'))
  })

  it('uses the reserved key name', () => {
    expect(PV_ATTRIBUTION_KEY).toBe('pvAttribution')
  })
})

describe('resolveAttribution: rejections (all non-retryable, before any transaction)', () => {
  it.each([
    [{ actorId: '' }, 'actor_id_invalid'],
    [{ actorId: 'x'.repeat(257) }, 'actor_id_invalid'],
    [{ actorId: 5 as unknown as string }, 'actor_id_invalid'],
    [{ occurredAt: 'yesterday' }, 'occurred_at_invalid'],
    [{ occurredAt: '2026-13-01T00:00:00Z' }, 'occurred_at_invalid'],
    [{ occurredAt: '2026-02-30T00:00:00Z' }, 'occurred_at_invalid'],
    [{ occurredAt: '2026-10-05' }, 'occurred_at_invalid'],
    [{ occurredAt: '2026-10-05T25:00:00Z' }, 'occurred_at_invalid'],
    [{ occurredAt: 1_790_000_000 as unknown as string }, 'occurred_at_invalid'],
    [{ occurredAt: '' }, 'occurred_at_invalid'],
  ] as Array<[Partial<Input>, AttributionRejectCode]>)('shape %j -> %s', (over, code) => {
    expect(codeOf(base(over), snapshot())).toBe(code)
  })

  it('a top-level pvAttribution payload key is reserved, with or without delegation', () => {
    const payload = { [PV_ATTRIBUTION_KEY]: { forged: true } }
    expect(codeOf(base({ payload }))).toBe('reserved_payload_key')
    expect(codeOf(base({ payload }), snapshot())).toBe('reserved_payload_key')
    expect(() =>
      resolveAttribution(base({ payload: { nested: payload } }), undefined, NOW)
    ).not.toThrow()
  })

  it('an actorId needs a delegated request and must equal its actor', () => {
    expect(codeOf(base({ actorId: 'user_01EXAMPLE' }))).toBe('actor_requires_delegation')
    expect(codeOf(base({ actorId: 'someone_else' }), snapshot())).toBe('actor_mismatch')
  })

  it('a delegated actor is never attributed on another org', () => {
    expect(codeOf(base({ orgId: OTHER_ORG }), snapshot())).toBe('delegation_org_mismatch')
  })

  it('occurredAt must equal the signed occ to the second', () => {
    const ambient = snapshot({ occurredAtSeconds: OCC_SECONDS })
    expect(
      codeOf(base({ occurredAt: new Date((OCC_SECONDS + 1) * 1000).toISOString() }), ambient)
    ).toBe('occurred_at_mismatch')
  })

  it('without a signed occ, a delegated occurredAt may be at most 90 s old', () => {
    const at = (ageSeconds: number) => new Date(NOW - ageSeconds * 1000).toISOString()
    expect(
      resolveAttribution(base({ occurredAt: at(90) }), snapshot(), NOW)?.occurredAtSource
    ).toBe('extension')
    expect(codeOf(base({ occurredAt: at(91) }), snapshot())).toBe('occurred_at_unattested')
  })

  it('the future bound is now + 30 s, with and without delegation', () => {
    const at = (offsetSeconds: number) => new Date(NOW + offsetSeconds * 1000).toISOString()
    expect(resolveAttribution(base({ occurredAt: at(30) }), undefined, NOW)).toBeDefined()
    expect(codeOf(base({ occurredAt: at(31) }))).toBe('occurred_at_in_future')
    expect(codeOf(base({ occurredAt: at(31) }), snapshot())).toBe('occurred_at_in_future')
  })

  it('the 30 day hard cap applies outside delegation, and to a signed occ at the write boundary', () => {
    const at = (ageSeconds: number) => new Date(NOW - ageSeconds * 1000).toISOString()
    const day = 86_400
    expect(resolveAttribution(base({ occurredAt: at(30 * day) }), undefined, NOW)).toBeDefined()
    expect(codeOf(base({ occurredAt: at(30 * day + 1) }))).toBe('occurred_at_too_old')
    const oldOcc = Math.floor(NOW / 1000) - 31 * day
    expect(codeOf(base(), snapshot({ occurredAtSeconds: oldOcc }))).toBe('occurred_at_too_old')
  })

  it('does not trip over a signed occ that aged a few seconds past the route window since S1', () => {
    const occ = Math.floor(NOW / 1000) - 120
    expect(resolveAttribution(base(), snapshot({ occurredAtSeconds: occ }), NOW)).toBeDefined()
  })
})

describe('attributionFingerprintPart', () => {
  it('is undefined without attribution (the pre-71.4 fingerprint is unchanged)', () => {
    expect(attributionFingerprintPart(undefined)).toBeUndefined()
  })

  it('covers the effective time, provider and subject only', () => {
    const attribution = resolveAttribution(
      base(),
      snapshot({ occurredAtSeconds: OCC_SECONDS }),
      NOW
    )
    expect(attributionFingerprintPart(attribution)).toEqual({
      occurredAt: OCC_ISO,
      actor: { provider: 'workos', subject: 'user_01EXAMPLE' },
    })
  })

  it('ignores delegatedBy, the assertion id, the kid, the reason, the user id and the attestation', () => {
    const first = resolveAttribution(base(), snapshot(), NOW)
    const retry = resolveAttribution(
      base(),
      snapshot({
        delegatedBy: { kid: 'cm-deleg-2', issuer: 'https://other.example', assertionId: 'jti-2' },
      }),
      NOW
    )
    expect(attributionFingerprintPart(retry)).toEqual(attributionFingerprintPart(first))
  })
})
