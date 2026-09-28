import { describe, expect, it } from 'vitest'
import { HandoffEvent } from '@project-vault/shared'
import { ClaimRekeyMissError, classifyClaimExchangeError } from './handoff-claim-exchange-db.js'

// Story 60.5 AC3b rows 3b.2-3b.4: DB-free unit tests of the single classifier shared by the
// claim-exchange transaction and burnJti() (Design Decision 3).
describe('classifyClaimExchangeError (Story 60.5 AC3b)', () => {
  it('3b.3: a bare pg unique violation (23505) is a replay', () => {
    expect(classifyClaimExchangeError({ code: '23505' })).toBe(HandoffEvent.HANDOFF_REPLAY)
  })

  it('3b.3: a drizzle-wrapped unique violation (cause.code 23505) is a replay', () => {
    expect(classifyClaimExchangeError({ cause: { code: '23505' } })).toBe(
      HandoffEvent.HANDOFF_REPLAY
    )
  })

  it('3b.4: the 0-row re-key sentinel is a replay', () => {
    expect(classifyClaimExchangeError(new ClaimRekeyMissError())).toBe(HandoffEvent.HANDOFF_REPLAY)
  })

  it.each([
    ['a connection failure (08006)', { code: '08006' }],
    ['a wrapped statement timeout (cause.code 57014)', { cause: { code: '57014' } }],
    ['a plain Error', new Error('connection reset')],
    ['a non-object throw', 'boom'],
    ['undefined', undefined],
    ['null', null],
  ])('3b.2: %s maps to replay-store-unavailable', (_label, error) => {
    expect(classifyClaimExchangeError(error)).toBe(HandoffEvent.HANDOFF_REPLAY_STORE_UNAVAILABLE)
  })

  it('ClaimRekeyMissError is a real Error with a stable name', () => {
    const error = new ClaimRekeyMissError()
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('ClaimRekeyMissError')
  })
})
