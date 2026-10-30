import { describe, expect, it } from 'vitest'
import { SHARE_ERROR_REASONS } from '@project-vault/shared'
import { ApiClientError } from './client.js'
import { m } from '$lib/paraglide/messages.js'
import { shareErrorReasonMessage, shareReasonMessage } from './share-error-reason.js'

describe('share error reasons (Story 72.11 AC3)', () => {
  it.each(SHARE_ERROR_REASONS)('maps %s to a non-empty localized message', (reason) => {
    const message = shareReasonMessage(reason)
    expect(message.length).toBeGreaterThan(0)
    // A missing key renders as the key itself; a real message is a sentence.
    expect(message).not.toContain('share_reason_')
    // The generic fallback means the map has no entry for this reason.
    expect(message).not.toBe(m.share_reason_generic())
  })

  it('every reason has a distinct message', () => {
    const messages = SHARE_ERROR_REASONS.map((reason) => shareReasonMessage(reason))
    expect(new Set(messages).size).toBe(SHARE_ERROR_REASONS.length)
  })

  it('reads the reason from an ApiClientError body', () => {
    const error = new ApiClientError(
      400,
      { code: 'expires_at_invalid', reason: 'expiry_in_past', message: 'raw' },
      'raw'
    )
    expect(shareErrorReasonMessage(error)).toBe(shareReasonMessage('expiry_in_past'))
  })

  it('returns null without a reason, with an unknown reason, and for a non-API error', () => {
    expect(shareErrorReasonMessage(new ApiClientError(404, { code: 'x' }, 'x'))).toBeNull()
    expect(shareErrorReasonMessage(new ApiClientError(400, { reason: 'toString' }, 'x'))).toBeNull()
    expect(shareErrorReasonMessage(new Error('boom'))).toBeNull()
  })
})
