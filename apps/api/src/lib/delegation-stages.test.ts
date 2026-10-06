import { Readable } from 'node:stream'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'
import { stubReply } from '../__tests__/helpers/secure-route-stubs.js'
import {
  DELEGATION_BURN_DEADLINE_MS,
  DELEGATION_NIL_USER_ID,
  DELEGATION_PRE_BURN_LIMIT,
  delegationBodyStage,
  delegationKidBucket,
  delegationResolveStage,
  delegationSubjectStage,
  normalizeDelegation,
  parseDelegationHeader,
  resolveHistoricalAdmission,
} from './delegation-stages.js'

/**
 * Story 71.3 — unit tests of the pure pieces and of the defensive branches of the stages. The
 * end-to-end behaviour (real `secureRoute`, real Postgres) is in
 * `secure-route-delegation.integration.test.ts`.
 */

function fakeRequest(): FastifyRequest {
  return {
    headers: {},
    ip: '203.0.113.9',
    log: { error: () => undefined },
    routeOptions: { bodyLimit: 1024 },
  } as unknown as FastifyRequest
}

describe('parseDelegationHeader (design check 1)', () => {
  it('returns the bare compact JWS for a well-formed PV-Delegation header', () => {
    expect(parseDelegationHeader('PV-Delegation aaa.bbb.ccc')).toBe('aaa.bbb.ccc')
  })

  it.each([
    ['undefined', undefined],
    ['an array', ['PV-Delegation a.b.c']],
    ['another scheme', 'Bearer a.b.c'],
    ['a lowercase scheme', 'pv-delegation a.b.c'],
    ['no token', 'PV-Delegation '],
    ['no space', 'PV-Delegation'],
    ['two spaces', 'PV-Delegation  a.b.c'],
    ['whitespace inside the token', 'PV-Delegation a.b c'],
    ['a trailing space', 'PV-Delegation a.b.c '],
  ])('rejects %s', (_name, value) => {
    expect(parseDelegationHeader(value)).toBeUndefined()
  })
})

describe('normalizeDelegation', () => {
  it('turns false, undefined and null into false (a session route)', () => {
    expect(normalizeDelegation(false)).toBe(false)
    expect(normalizeDelegation(undefined)).toBe(false)
    expect(normalizeDelegation(null)).toBe(false)
  })

  it('turns true and {} into a stage config with no subject fields', () => {
    expect(normalizeDelegation(true)).toEqual({ subjectFields: undefined })
    expect(normalizeDelegation({})).toEqual({ subjectFields: undefined })
    expect(normalizeDelegation([])).toEqual({ subjectFields: undefined })
    expect(normalizeDelegation({ subjectFields: 'nope' })).toEqual({ subjectFields: undefined })
  })

  it('carries the declared subject fields', () => {
    const subjectFields = { org: { in: 'body', name: 'orgId' } }
    expect(normalizeDelegation({ subjectFields })).toEqual({ subjectFields })
  })
})

describe('constants and the 71-4 seam', () => {
  it('pins the sentinel, the deadline and the kid bucket', () => {
    expect(DELEGATION_NIL_USER_ID).toBe(
      ['00000000', '0000', '0000', '0000', '000000000000'].join('-')
    )
    expect(DELEGATION_BURN_DEADLINE_MS).toBe(3000)
    expect(DELEGATION_PRE_BURN_LIMIT).toEqual({ max: 1200, timeWindowMs: 60_000 })
    expect(delegationKidBucket('kid-1')).toEqual({
      userId: 'delegation-kid:kid-1',
      key: 'delegation-pre-burn',
    })
  })

  it('admits through resolveHistoricalAdmission only with a route policy AND a signed occ (71-4)', () => {
    const policy = { maxAgeSeconds: 600 }
    expect(resolveHistoricalAdmission({ policy, occurredAt: 5 })).toEqual({ admitted: true })
    expect(resolveHistoricalAdmission({ policy, occurredAt: undefined })).toEqual({
      admitted: false,
    })
    expect(resolveHistoricalAdmission({ policy: undefined, occurredAt: 5 })).toEqual({
      admitted: false,
    })
  })

  it('normalizeDelegation keeps a well-formed historical policy and drops anything else', () => {
    expect(normalizeDelegation({ historicalActorPolicy: { maxAgeSeconds: 600 } })).toEqual({
      subjectFields: undefined,
      historicalActorPolicy: { maxAgeSeconds: 600 },
    })
    for (const bad of [{}, { maxAgeSeconds: 0 }, { maxAgeSeconds: '9' }, null, 'x']) {
      expect(normalizeDelegation({ historicalActorPolicy: bad })).toEqual({
        subjectFields: undefined,
      })
    }
    expect(normalizeDelegation(true)).toEqual({ subjectFields: undefined })
  })
})

describe('stages that run without a verified request fail closed with the generic 401', () => {
  it('S2 answers 401 delegation_invalid and does not read the body', async () => {
    const reply = stubReply()
    const payload = Readable.from([Buffer.from('{"a":1}')])
    const out = await delegationBodyStage('POST /x')(
      fakeRequest(),
      reply as unknown as FastifyReply,
      payload
    )
    expect(out).toBeUndefined()
    expect(reply.statusCode).toBe(401)
    expect(reply.body).toMatchObject({ code: 'delegation_invalid' })
    expect(payload.readableFlowing).toBeNull()
  })

  it.each([
    ['S3', delegationSubjectStage('POST /x', { subjectFields: undefined })],
    ['S4', delegationResolveStage('POST /x', { subjectFields: undefined })],
  ])('%s answers 401 delegation_invalid without reaching the database', async (_name, stage) => {
    const reply = stubReply()
    await stage(fakeRequest(), reply as unknown as FastifyReply)
    expect(reply.statusCode).toBe(401)
    expect(reply.body).toMatchObject({ code: 'delegation_invalid' })
  })
})
