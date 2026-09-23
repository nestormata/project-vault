import { describe, expect, it } from 'vitest'
import { parseClientInvocationContext } from './client-invocation-context.js'

const INVOCATION = 'x-vault-invocation'
const TARGET = 'x-vault-target-command'

describe('parseClientInvocationContext (Story 43.4 AC-3)', () => {
  it('absent headers produce no payload keys at all (existing callers stay byte-identical)', () => {
    expect(parseClientInvocationContext({})).toEqual({})
  })

  it('accepts a get invocation with no target command', () => {
    expect(parseClientInvocationContext({ [INVOCATION]: 'get' })).toEqual({
      clientInvocation: 'get',
    })
  })

  it('accepts a write-env invocation (Story 43.5 AC-8 — revealed and persisted to disk)', () => {
    expect(parseClientInvocationContext({ [INVOCATION]: 'write-env' })).toEqual({
      clientInvocation: 'write-env',
    })
  })

  it('accepts a run invocation and stores the percent-decoded target command', () => {
    expect(
      parseClientInvocationContext({
        [INVOCATION]: 'run',
        [TARGET]: '%E3%83%87%E3%83%BC%E3%82%BF.sh',
      })
    ).toEqual({ clientInvocation: 'run', clientTargetCommand: 'データ.sh' })
  })

  it.each([
    ['an invocation outside the allowlist', { [INVOCATION]: 'admin' }, {}],
    ['a repeated invocation header (array value)', { [INVOCATION]: ['get', 'run'] }, {}],
    [
      'an encoded newline in the target command',
      { [INVOCATION]: 'run', [TARGET]: 'evil%0Acmd' },
      { clientInvocation: 'run' },
    ],
    [
      'an encoded C1 control character (NEL)',
      { [INVOCATION]: 'run', [TARGET]: 'evil%C2%85cmd' },
      { clientInvocation: 'run' },
    ],
    [
      'an encoded ANSI escape',
      { [INVOCATION]: 'run', [TARGET]: '%1B%5B31mred' },
      { clientInvocation: 'run' },
    ],
    [
      'an oversized (500-char) target command',
      { [INVOCATION]: 'run', [TARGET]: 'a'.repeat(500) },
      { clientInvocation: 'run' },
    ],
    [
      'malformed percent-encoding (would throw URIError)',
      { [INVOCATION]: 'run', [TARGET]: '%E0%A4%A' },
      { clientInvocation: 'run' },
    ],
    [
      'a raw character outside the encoded alphabet',
      { [INVOCATION]: 'run', [TARGET]: 'psql --host x' },
      { clientInvocation: 'run' },
    ],
    ['an empty target command', { [INVOCATION]: 'run', [TARGET]: '' }, { clientInvocation: 'run' }],
  ])('drops and flags %s — never throws', (_label, headers, kept) => {
    expect(parseClientInvocationContext(headers)).toEqual({
      ...kept,
      clientInvocationContextRejected: true,
    })
  })

  it('a target command without an invocation header is still recorded (each header validated independently)', () => {
    expect(parseClientInvocationContext({ [TARGET]: 'psql' })).toEqual({
      clientTargetCommand: 'psql',
    })
  })
})
