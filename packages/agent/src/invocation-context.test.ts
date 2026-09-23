import { describe, expect, it } from 'vitest'
import {
  buildInvocationContextHeaders,
  encodeTargetCommand,
  TARGET_COMMAND_HEADER_MAX_LENGTH,
} from './invocation-context.js'

/** Mirrors the server's own acceptance pattern
 * (apps/api/src/modules/machine-users/machine-credential-schema.ts) — every value this module
 * produces must pass it, or the server would drop the field and flag the request as rejected. */
const SERVER_PATTERN = /^[A-Za-z0-9%._+~-]{1,128}$/

describe('encodeTargetCommand (Story 43.4 AC-3)', () => {
  it.each([
    ['psql', 'psql'],
    ['deploy.sh', 'deploy.sh'],
    ['psql.exe', 'psql.exe'],
    ['データ.sh', '%E3%83%87%E3%83%BC%E3%82%BF.sh'],
    ['my tool', 'my%20tool'],
    ["weird!'()*", 'weird%21%27%28%29%2A'],
    ['a+b', 'a%2Bb'],
    ['line\nbreak', 'line%0Abreak'],
  ])('percent-encodes %j to a server-acceptable token', (input, expected) => {
    const encoded = encodeTargetCommand(input)
    expect(encoded).toBe(expected)
    expect(encoded).toMatch(SERVER_PATTERN)
  })

  it('truncates to at most 128 encoded characters without splitting an escape or a code point', () => {
    const encoded = encodeTargetCommand('x'.repeat(300))
    expect(encoded).toHaveLength(TARGET_COMMAND_HEADER_MAX_LENGTH)
    expect(TARGET_COMMAND_HEADER_MAX_LENGTH).toBe(128)

    // 127 ASCII chars + a 9-char-encoded kana — the kana must be dropped whole, never split into a
    // malformed partial escape the server's decodeURIComponent would reject.
    const mixed = encodeTargetCommand(`${'y'.repeat(127)}データ`)
    expect(mixed).toBe('y'.repeat(127))
    expect(() => decodeURIComponent(mixed)).not.toThrow()
  })

  it('never throws on a lone surrogate (encodeURIComponent would throw URIError) — substitutes U+FFFD', () => {
    const encoded = encodeTargetCommand('bad\uD800name')
    expect(encoded).toBe('bad%EF%BF%BDname')
    expect(encoded).toMatch(SERVER_PATTERN)
  })

  it('returns an empty string for an empty command', () => {
    expect(encodeTargetCommand('')).toBe('')
  })
})

describe('buildInvocationContextHeaders (Story 43.4 AC-3)', () => {
  it('returns no headers when no context is given (vault-action and older callers stay byte-identical)', () => {
    expect(buildInvocationContextHeaders(undefined)).toEqual({})
  })

  it('sends x-vault-invocation only for `get`', () => {
    expect(buildInvocationContextHeaders({ invocation: 'get' })).toEqual({
      'x-vault-invocation': 'get',
    })
  })

  it('sends x-vault-invocation only for `write-env` (Story 43.5 AC-8 — persisted to disk)', () => {
    expect(buildInvocationContextHeaders({ invocation: 'write-env' })).toEqual({
      'x-vault-invocation': 'write-env',
    })
  })

  it('sends both headers for `run`, with the target command percent-encoded', () => {
    expect(
      buildInvocationContextHeaders({ invocation: 'run', targetCommand: 'データ.sh' })
    ).toEqual({
      'x-vault-invocation': 'run',
      'x-vault-target-command': '%E3%83%87%E3%83%BC%E3%82%BF.sh',
    })
  })

  it('omits the target-command header when the encoded command is empty', () => {
    expect(buildInvocationContextHeaders({ invocation: 'run', targetCommand: '' })).toEqual({
      'x-vault-invocation': 'run',
    })
  })

  it('drops an invocation label outside the closed allowlist (a plain-JS caller bypassing the type) rather than sending it', () => {
    const context = { invocation: 'admin' } as unknown as Parameters<
      typeof buildInvocationContextHeaders
    >[0]
    expect(buildInvocationContextHeaders(context)).toEqual({})
  })

  it('every produced header value is a valid ByteString, so fetch() can never throw a TypeError on it', () => {
    const headers = buildInvocationContextHeaders({
      invocation: 'run',
      targetCommand: '\u0000ÿ\u{1F600}データ\r\n',
    })
    for (const value of Object.values(headers)) {
      expect(() => new Headers({ probe: value })).not.toThrow()
      expect(value).toMatch(/^[\x21-\x7e]+$/)
    }
  })
})
