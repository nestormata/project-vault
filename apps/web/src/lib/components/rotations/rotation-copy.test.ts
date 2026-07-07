import { describe, expect, it } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'
import { onboardingCopy } from '$lib/components/onboarding/onboarding-logic.js'
import {
  checklistItemStatusBadgeClass,
  checklistItemStatusLabel,
  mapRotationMutationError,
  rotationCopy,
  rotationStatusBadgeClass,
  rotationStatusLabel,
} from './rotation-copy.js'

describe('rotation copy and status badges', () => {
  it('shares a single "No rotations yet." empty-state string (AC-1/AC-18)', () => {
    expect(rotationCopy.noRotationsYet).toBe('No rotations yet.')
  })

  it('conveys checklist item status via text, not color alone (AC-26)', () => {
    expect(checklistItemStatusLabel('unconfirmed')).toBe('unconfirmed')
    expect(checklistItemStatusLabel('confirmed')).toBe('confirmed')
    expect(checklistItemStatusLabel('failed')).toBe('failed')
    expect(checklistItemStatusLabel('max_retries_exceeded')).toBe('max retries exceeded')
  })

  it('maps checklist item statuses to distinct badge classes', () => {
    expect(checklistItemStatusBadgeClass('unconfirmed')).toContain('slate')
    expect(checklistItemStatusBadgeClass('confirmed')).toContain('emerald')
    expect(checklistItemStatusBadgeClass('failed')).toContain('red')
    expect(checklistItemStatusBadgeClass('max_retries_exceeded')).toContain('red')
  })

  it('maps rotation statuses to labels and badge classes', () => {
    expect(rotationStatusLabel('in_progress')).toBe('in_progress')
    expect(rotationStatusBadgeClass('completed')).toContain('emerald')
    expect(rotationStatusBadgeClass('abandoned')).toContain('slate')
    expect(rotationStatusBadgeClass('stale_recovery')).toContain('amber')
    expect(rotationStatusBadgeClass('break_glass_complete')).toContain('red')
  })
})

// AC-20/AC-21: single shared error-mapping helper for the 503/mfa_required/429/generic branches
// every rotation mutation call site (initiate, break-glass, confirm/fail/retry, complete,
// resume/abandon) must use instead of independently re-deriving the same three branches.
describe('mapRotationMutationError (AC-20)', () => {
  it('AC-1..AC-5 shared building block: 503 reuses onboardingCopy.vaultSealedMessage verbatim', () => {
    const error = new ApiClientError(503, { status: 'sealed', message: 'sealed' }, 'sealed')
    expect(mapRotationMutationError(error, {}, 'fallback')).toBe(onboardingCopy.vaultSealedMessage)
  })

  it('AC-6..AC-10/AC-21: 403 mfa_required produces an action-specific "Enable MFA to ..." message containing MFA', () => {
    const error = new ApiClientError(
      403,
      { code: 'mfa_required', message: 'MFA enrollment is required for Owner and Admin roles.' },
      'MFA enrollment is required for Owner and Admin roles.'
    )
    expect(mapRotationMutationError(error, { actionLabel: 'start a rotation' }, 'fallback')).toBe(
      'Enable MFA to start a rotation.'
    )
    expect(
      mapRotationMutationError(error, { actionLabel: 'perform a break-glass rotation' }, 'fallback')
    ).toBe('Enable MFA to perform a break-glass rotation.')
    expect(
      mapRotationMutationError(error, { actionLabel: 'complete this rotation' }, 'fallback')
    ).toBe('Enable MFA to complete this rotation.')
    expect(
      mapRotationMutationError(error, { actionLabel: 'resume this rotation' }, 'fallback')
    ).toBe('Enable MFA to resume this rotation.')
    expect(
      mapRotationMutationError(error, { actionLabel: 'abandon this rotation' }, 'fallback')
    ).toBe('Enable MFA to abandon this rotation.')
  })

  it('AC-11/AC-13/AC-14: 429 with retryAfter renders a generic countdown message by default', () => {
    const error = new ApiClientError(
      429,
      { code: 'rate_limit_exceeded', message: 'Too many authenticated requests', retryAfter: 12 },
      'Too many authenticated requests'
    )
    expect(mapRotationMutationError(error, {}, 'fallback')).toBe(
      'Too many attempts. Try again in 12 seconds.'
    )
  })

  it('AC-11 edge: retryAfter: 0 renders literally, not specialcased to "now"', () => {
    const error = new ApiClientError(
      429,
      { code: 'rate_limit_exceeded', message: 'Too many authenticated requests', retryAfter: 0 },
      'Too many authenticated requests'
    )
    expect(mapRotationMutationError(error, {}, 'fallback')).toBe(
      'Too many attempts. Try again in 0 seconds.'
    )
  })

  it('AC-12: 429 with rateLimitFraming "break-glass" adds the incident-response reassurance clause', () => {
    const error = new ApiClientError(
      429,
      { code: 'rate_limit_exceeded', message: 'Too many authenticated requests', retryAfter: 45 },
      'Too many authenticated requests'
    )
    expect(mapRotationMutationError(error, { rateLimitFraming: 'break-glass' }, 'fallback')).toBe(
      'Too many break-glass attempts. Try again in 45 seconds — this limit exists to prevent runaway automated calls, not to block a real incident response.'
    )
  })

  it('429 with retryAfter missing/undefined falls back to a generic "try again shortly" message, never crashes', () => {
    const error = new ApiClientError(
      429,
      { code: 'rate_limit_exceeded', message: 'Too many authenticated requests' },
      'Too many authenticated requests'
    )
    expect(mapRotationMutationError(error, {}, 'fallback')).toBe('Try again shortly.')
  })

  it('falls back to the raw error.message for any other ApiClientError (e.g. 409/422/404)', () => {
    const error = new ApiClientError(
      422,
      { message: 'Value exceeds the limit.' },
      'Value exceeds the limit.'
    )
    expect(mapRotationMutationError(error, {}, 'fallback')).toBe('Value exceeds the limit.')
  })

  it('falls back to a generic Error message for non-ApiClientError errors, and to the fallback string otherwise', () => {
    expect(mapRotationMutationError(new Error('network down'), {}, 'fallback')).toBe('network down')
    expect(mapRotationMutationError('not an error', {}, 'fallback')).toBe('fallback')
  })
})
