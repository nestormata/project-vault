import { VaultAgentError } from '@project-vault/agent'
import { describe, expect, it } from 'vitest'
import { messageForAgentError } from './agent-error-messages.js'
import { ERROR_TEXT_MAX_CODE_POINTS } from './sanitize-server-text.js'

// Story 43.13 AC-2 — VaultAgentError.message is free text (it can embed a server-echoed or hostile
// credential name), so it goes through sanitizeServerText with the 500-code-point error cap.

const UNREACHABLE_PREFIX = "Vault is unreachable and no usable cached value exists for 'DB_URL': "
const FALLBACK_PREFIX = "Failed to retrieve secret 'DB_URL': "

const unreachable = (message: string) => new VaultAgentError('vault_unreachable', message)
const fallback = (message: string) => new VaultAgentError('vault_request_failed', message)

describe('messageForAgentError free-text shaping (Story 43.13 AC-2)', () => {
  it('renders an ordinary network error byte-for-byte as before', () => {
    expect(messageForAgentError(unreachable('connect ECONNREFUSED 10.0.0.5:443'), 'DB_URL')).toBe(
      `${UNREACHABLE_PREFIX}connect ECONNREFUSED 10.0.0.5:443`
    )
  })

  it.each([
    ['UNREACHABLE', unreachable, UNREACHABLE_PREFIX],
    ['fallback', fallback, FALLBACK_PREFIX],
  ] as const)('%s branch strips a bidi override from the error text', (_label, make, prefix) => {
    expect(messageForAgentError(make('credential "x\u202Egpj.exe" failed'), 'DB_URL')).toBe(
      `${prefix}credential "xgpj.exe" failed`
    )
  })

  it.each([
    ['UNREACHABLE', unreachable, UNREACHABLE_PREFIX],
    ['fallback', fallback, FALLBACK_PREFIX],
  ] as const)('%s branch renders multi-line server text on one line', (_label, make, prefix) => {
    const out = messageForAgentError(make('line one\nFAKE: all secrets rotated'), 'DB_URL')
    expect(out).toBe(`${prefix}line one FAKE: all secrets rotated`)
    expect(out).not.toContain('\n')
  })

  it('prints an error text of exactly the cap whole', () => {
    const text = 'e'.repeat(ERROR_TEXT_MAX_CODE_POINTS)
    expect(messageForAgentError(unreachable(text), 'DB_URL')).toBe(`${UNREACHABLE_PREFIX}${text}`)
  })

  it('cuts one code point over the cap to cap-1 code points plus an ellipsis (astral)', () => {
    const out = messageForAgentError(
      unreachable('\u{1F600}'.repeat(ERROR_TEXT_MAX_CODE_POINTS + 1)),
      'DB_URL'
    )
    expect(out).toBe(`${UNREACHABLE_PREFIX}${'\u{1F600}'.repeat(ERROR_TEXT_MAX_CODE_POINTS - 1)}…`)
  })

  it('caps a 5 000-code-point flood without counting or cutting the prefix and name', () => {
    const out = messageForAgentError(fallback('z'.repeat(5000)), 'DB_URL')
    expect(out.startsWith(FALLBACK_PREFIX)).toBe(true)
    expect([...out.slice(FALLBACK_PREFIX.length)]).toHaveLength(ERROR_TEXT_MAX_CODE_POINTS)
    expect(out.endsWith('…')).toBe(true)
  })

  it('renders a whitespace-only error text as empty, never crashing', () => {
    expect(messageForAgentError(fallback('   '), 'DB_URL')).toBe(FALLBACK_PREFIX)
  })

  it('leaves per-code messages (no error text) unchanged', () => {
    expect(messageForAgentError(new VaultAgentError('credential_not_found', 'x'), 'DB_URL')).toBe(
      "Credential 'DB_URL' was not found in this project."
    )
  })
})
