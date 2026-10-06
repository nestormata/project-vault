import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import {
  actorAttributionCondition,
  isValidActorFilter,
  parsePvAttribution,
  pvAttributionProjection,
} from './attribution-display.js'
import { searchAuditEvents } from './search.js'

const USER_ID = randomUUID()
const U202E = String.fromCodePoint(0x202e)
const U2066 = String.fromCodePoint(0x2066)
const U200B = String.fromCodePoint(0x200b)
const U200E = String.fromCodePoint(0x200e)
const DELEGATED_BY = { kid: 'kid-1', issuer: 'https://issuer.example', assertionId: 'jti-1' }

function stored(actor: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) {
  return {
    v: 1,
    ...(actor === undefined ? {} : { actor }),
    delegatedBy: DELEGATED_BY,
    ...extra,
  }
}

describe('parsePvAttribution', () => {
  it('maps issuer_attested/unlinked without exposing userId or delegatedBy', () => {
    const result = parsePvAttribution(
      stored({
        provider: 'workos',
        subject: 'user_01X',
        userId: null,
        attestation: 'issuer_attested',
        reason: 'unlinked',
      })
    )
    expect(result).toEqual({
      actor: {
        kind: 'issuer_attested',
        provider: 'workos',
        subject: 'user_01X',
        reason: 'unlinked',
      },
    })
    expect(JSON.stringify(result)).not.toMatch(/kid-1|jti-1|userId|delegatedBy/)
  })

  it('maps issuer_attested/not_current_member and hides the stored user id', () => {
    const result = parsePvAttribution(
      stored({
        provider: 'workos',
        subject: 'user_02',
        userId: USER_ID,
        attestation: 'issuer_attested',
        reason: 'not_current_member',
      })
    )
    expect(result?.actor).toEqual({
      kind: 'issuer_attested',
      provider: 'workos',
      subject: 'user_02',
      reason: 'not_current_member',
    })
    expect(JSON.stringify(result)).not.toContain(USER_ID)
  })

  it('maps pv_verified with a null reason', () => {
    const result = parsePvAttribution(
      stored({
        provider: 'p',
        subject: 's',
        userId: USER_ID,
        attestation: 'pv_verified',
        reason: null,
      })
    )
    expect(result?.actor).toEqual({
      kind: 'pv_verified',
      provider: 'p',
      subject: 's',
      reason: null,
    })
  })

  it('returns occurredAt and occurredAtSource when stored, without an actor', () => {
    expect(
      parsePvAttribution({
        v: 1,
        occurredAt: '2026-10-01T10:00:00.000Z',
        occurredAtSource: 'extension',
      })
    ).toEqual({ occurredAt: '2026-10-01T10:00:00.000Z', occurredAtSource: 'extension' })
  })

  it('returns undefined for a delegation-less attribution with nothing to show', () => {
    expect(parsePvAttribution({ v: 1 })).toBeUndefined()
  })

  const goodActor = {
    provider: 'workos',
    subject: 'user_01X',
    userId: null,
    attestation: 'issuer_attested',
    reason: 'unlinked',
  }
  const hostile: [string, unknown][] = [
    ['undefined', undefined],
    ['null', null],
    ['a string', 'pvAttribution'],
    ['an array', [1]],
    ['v 2', { ...stored(goodActor), v: 2 }],
    ['missing v', { actor: goodActor }],
    ['actor without provider', stored({ ...goodActor, provider: undefined })],
    ['actor without subject', stored({ ...goodActor, subject: undefined })],
    ['non-string subject', stored({ ...goodActor, subject: 7 })],
    ['pv_verified with a reason', stored({ ...goodActor, attestation: 'pv_verified' })],
    ['issuer_attested without a reason', stored({ ...goodActor, reason: null })],
    ['unknown attestation', stored({ ...goodActor, attestation: 'trusted' })],
    ['unknown reason', stored({ ...goodActor, reason: 'because' })],
    ['300-char subject', stored({ ...goodActor, subject: 'a'.repeat(300) })],
    ['65-char provider', stored({ ...goodActor, provider: 'p'.repeat(65) })],
    ['empty subject', stored({ ...goodActor, subject: '' })],
    ['NUL in subject', stored({ ...goodActor, subject: 'a\u0000b' })],
    ['newline in subject', stored({ ...goodActor, subject: 'a\nb' })],
    ['DEL in provider', stored({ ...goodActor, provider: 'a\u007fb' })],
    ['RLO bidi in subject', stored({ ...goodActor, subject: `abc${U202E}def` })],
    ['isolate bidi in subject', stored({ ...goodActor, subject: `abc${U2066}def` })],
    ['zero-width space in subject', stored({ ...goodActor, subject: `Nestor${U200B}Mata` })],
    ['LRM in provider', stored({ ...goodActor, provider: `wo${U200E}os` })],
    ['bad occurredAt type', { v: 1, occurredAt: 5, actor: goodActor }],
    ['bad occurredAtSource', { v: 1, occurredAtSource: 'guess', actor: goodActor }],
  ]

  it.each(hostile)('fails closed (undefined) for %s', (_name, raw) => {
    expect(parsePvAttribution(raw)).toBeUndefined()
  })

  it('accepts a 256-char subject and a 64-char provider (the caps are inclusive)', () => {
    const result = parsePvAttribution(
      stored({ ...goodActor, subject: 's'.repeat(256), provider: 'p'.repeat(64) })
    )
    expect(result?.actor?.subject).toHaveLength(256)
  })
})

describe('query shape (D1/D3)', () => {
  const dialect = new PgDialect()

  it('projects the pvAttribution sub-path of extension rows only, never the whole payload', () => {
    const { sql: text } = dialect.sqlToQuery(pvAttributionProjection)
    expect(text).toContain("#> '{pvAttribution}'")
    expect(text).toContain("= 'extension'")
    expect(text.replaceAll('"audit_log_entries"."payload" #> ', '')).not.toContain(
      '"audit_log_entries"."payload"'
    )
  })

  it('binds provider and subject as one parameter, never into the SQL text', () => {
    const { sql: text, params } = dialect.sqlToQuery(
      actorAttributionCondition('wo"rkos', "x'; DROP TABLE t;--%_\\{")
    )
    expect(text).not.toContain('DROP TABLE')
    expect(params).toEqual([
      JSON.stringify({
        pvAttribution: { actor: { provider: 'wo"rkos', subject: "x'; DROP TABLE t;--%_\\{" } },
      }),
    ])
  })

  it('selects no bare payload column in the search query', async () => {
    const selected: Record<string, unknown>[] = []
    const result = Promise.resolve([])
    const chain: Record<string, unknown> = Object.fromEntries(
      ['from', 'where', 'orderBy', 'limit', 'offset'].map((name) => [name, () => chain])
    )
    chain['then'] = result.then.bind(result)
    const tx = {
      select: (fields: Record<string, unknown>) => {
        selected.push(fields)
        return chain
      },
    }
    await searchAuditEvents(tx as never, { offset: 0, limit: 10 })
    const keys = selected.flatMap((fields) => Object.keys(fields))
    expect(keys).toContain('pvAttribution')
    expect(keys).not.toContain('payload')
  })
})

describe('isValidActorFilter', () => {
  it.each([
    [{}, true],
    [{ actorId: 'u' }, true],
    [{ actorProvider: 'p', actorSubject: 's' }, true],
    [{ actorProvider: 'p' }, false],
    [{ actorSubject: 's' }, false],
    [{ actorProvider: '', actorSubject: 's' }, false],
    [{ actorProvider: 'p', actorSubject: '' }, false],
    [{ actorProvider: 'p', actorSubject: 's'.repeat(257) }, false],
    [{ actorProvider: 'p'.repeat(65), actorSubject: 's' }, false],
    [{ actorId: 'u', actorProvider: 'p', actorSubject: 's' }, false],
  ])('%j -> %s', (input, expected) => {
    expect(isValidActorFilter(input)).toBe(expected)
  })
})
