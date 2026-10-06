import { describe, expect, it } from 'vitest'
import {
  classifyDelegationBurnError,
  describeStoreFailure,
  isRealSqlState,
  type DelegationBurnOutcome,
} from './delegation-replay-store.js'

/**
 * Story 71.9 AC-5 (DW-519 item 2): a `store_unavailable` outcome carries a `sqlState` only when it
 * is a real SQLSTATE. Node driver errnos are also five upper-case characters (`EPIPE`), so the
 * shape alone would have recorded a socket error as if Postgres had answered.
 */

function storeFailureOf(error: unknown) {
  const outcome: DelegationBurnOutcome = classifyDelegationBurnError(error)
  if (outcome.outcome !== 'store_unavailable') throw new Error(`unexpected ${outcome.outcome}`)
  return { sqlState: outcome.sqlState, failure: describeStoreFailure(outcome) }
}

describe('store failure classification (Story 71.9 AC-5)', () => {
  it('treats a unique violation on the burn key as replayed, never as a store failure', () => {
    const pk = 'delegation_assertion_jti_org_id_jti_pk'
    expect(classifyDelegationBurnError({ code: '23505', constraint_name: pk })).toEqual({
      outcome: 'replayed',
    })
  })

  it('keeps a real SQLSTATE such as 57P03 (cannot_connect_now)', () => {
    expect(storeFailureOf({ code: '57P03' })).toEqual({
      sqlState: '57P03',
      failure: 'sqlstate:57P03',
    })
    expect(storeFailureOf({ cause: { code: '57014' } })).toEqual({
      sqlState: '57014',
      failure: 'sqlstate:57014',
    })
  })

  it.each(['EPIPE', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EBUSY'])(
    'records a driver errno (%s) as driver_error with no sqlState',
    (code) => {
      const error = Object.assign(new Error('socket'), { code })
      expect(storeFailureOf(error)).toEqual({ sqlState: null, failure: 'driver_error' })
    }
  )

  it('records anything that is not a SQLSTATE shape as driver_error', () => {
    expect(storeFailureOf(new Error('boom'))).toEqual({ sqlState: null, failure: 'driver_error' })
    expect(storeFailureOf({ code: 'toolong1' })).toEqual({
      sqlState: null,
      failure: 'driver_error',
    })
    expect(storeFailureOf({ code: '5703' })).toEqual({ sqlState: null, failure: 'driver_error' })
    expect(storeFailureOf(null)).toEqual({ sqlState: null, failure: 'driver_error' })
  })

  it('describes the request deadline as timeout', () => {
    expect(
      describeStoreFailure({ outcome: 'store_unavailable', sqlState: null, timedOut: true })
    ).toBe('timeout')
  })

  it('accepts only five-character [0-9A-Z] codes that carry a digit and are not an errno', () => {
    expect(isRealSqlState('23505')).toBe(true)
    expect(isRealSqlState('XX000')).toBe(true)
    expect(isRealSqlState('EPIPE')).toBe(false)
    expect(isRealSqlState('abcde')).toBe(false)
    expect(isRealSqlState(42)).toBe(false)
  })
})
