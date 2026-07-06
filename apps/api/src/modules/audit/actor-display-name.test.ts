import { describe, it, expect } from 'vitest'
import { actorDisplayNameFor } from './actor-display-name.js'

describe('actorDisplayNameFor (AC-13 fallback chain)', () => {
  it('resolves a human actor with a token present in the map to the live display name', () => {
    const map = new Map([['token-1', 'Alice Chen']])
    expect(actorDisplayNameFor('human', 'token-1', map)).toBe('Alice Chen')
  })

  it('falls back to "unknown" for a human actor whose token is not in the map', () => {
    const map = new Map<string, string>()
    expect(actorDisplayNameFor('human', 'token-missing', map)).toBe('unknown')
  })

  it('falls back to "unknown" for a human actor with a null actor_token_id (defensive, should not occur in a clean DB)', () => {
    const map = new Map<string, string>()
    expect(actorDisplayNameFor('human', null, map)).toBe('unknown')
  })

  it('falls back to the literal "machine_user" for a machine_user actor (null actor_token_id, Story 8.1 D3)', () => {
    const map = new Map<string, string>()
    expect(actorDisplayNameFor('machine_user', null, map)).toBe('machine_user')
  })

  it('falls back to the literal "system" for a system actor (null actor_token_id)', () => {
    const map = new Map<string, string>()
    expect(actorDisplayNameFor('system', null, map)).toBe('system')
  })
})
