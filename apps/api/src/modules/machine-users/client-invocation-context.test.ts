import { describe, expect, it } from 'vitest'
import { parseClientInvocationContext } from './client-invocation-context.js'
import { ClientTargetCommandHeaderSchema } from './machine-credential-schema.js'

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

describe('ClientTargetCommandHeaderSchema rejects the terminal-unsafe set U (Story 43.13 AC-4.2/4.3)', () => {
  // Deliberately duplicated from packages/agent/src/terminal-unsafe-characters.ts (the source of
  // truth for U) and packages/cli/src/sanitize.test.ts's AC-1 table: the API cannot import the agent.
  const UNSAFE: ReadonlyArray<readonly [string, string]> = [
    ['ESC', '\u001B'],
    ['LF', '\n'],
    ['TAB', '\t'],
    ['DEL', '\u007F'],
    ['NEL (C1)', '\u0085'],
    ['U+061C ARABIC LETTER MARK', '\u061C'],
    ['U+00AD soft hyphen', '\u00AD'],
    ['U+200B zero-width space', '\u200B'],
    ['U+200D ZWJ', '\u200D'],
    ['U+200E LRM', '\u200E'],
    ['U+202E RLO', '\u202E'],
    ['U+2028 line separator', '\u2028'],
    ['U+2029 paragraph separator', '\u2029'],
    ['U+2060 word joiner', '\u2060'],
    ['U+2066 isolate', '\u2066'],
    ['U+2069 pop isolate', '\u2069'],
    ['U+206F', '\u206F'],
    ['U+FEFF BOM', '\uFEFF'],
    ['U+E0000 (unassigned tag block start)', '\u{E0000}'],
    ['U+E0001 LANGUAGE TAG', '\u{E0001}'],
    ['U+E007F CANCEL TAG', '\u{E007F}'],
  ]
  const SAFE: ReadonlyArray<readonly [string, string]> = [
    ['plain name', 'deploy.sh'],
    ['accented', 'caf\u00E9'],
    ['CJK', '\u30C7\u30FC\u30BF.sh'],
    ['NBSP', '\u00A0'],
    ['emoji', '\u{1F600}'],
    ['U+E0080 (past the tag block)', '\u{E0080}'],
    ['U+10FFFF', '\u{10FFFF}'],
  ]

  it.each(UNSAFE)('rejects %s', (_label, c) => {
    expect(ClientTargetCommandHeaderSchema.safeParse(encodeURIComponent(`a${c}b`)).success).toBe(
      false
    )
  })

  it.each(SAFE)('accepts %s', (_label, c) => {
    expect(ClientTargetCommandHeaderSchema.safeParse(encodeURIComponent(`a${c}b`))).toEqual({
      success: true,
      data: `a${c}b`,
    })
  })

  it.each([
    ['%E2%80%AE', 'U+202E'],
    ['%E2%80%8B', 'U+200B'],
    ['%C2%AD', 'U+00AD'],
    ['%F3%A0%80%81', 'U+E0001'],
  ])('drops a %s (%s) target command from the audit context, never throwing', (encoded) => {
    expect(
      parseClientInvocationContext({ [INVOCATION]: 'run', [TARGET]: `run${encoded}exe.sh` })
    ).toEqual({
      clientInvocation: 'run',
      clientInvocationContextRejected: true,
    })
  })

  it('still accepts deploy.sh and the encoded CJK name unchanged', () => {
    expect(parseClientInvocationContext({ [TARGET]: 'deploy.sh' })).toEqual({
      clientTargetCommand: 'deploy.sh',
    })
    expect(parseClientInvocationContext({ [TARGET]: '%E3%83%87%E3%83%BC%E3%82%BF.sh' })).toEqual({
      clientTargetCommand: '\u30C7\u30FC\u30BF.sh',
    })
  })
})
