import { describe, expect, it } from 'vitest'
import {
  SHARE_ERROR_REASONS,
  ShareApiErrorSchema,
  ShareErrorReasonSchema,
} from './share-error-reasons.js'

describe('share error reasons', () => {
  it('lists the V12 reasons exactly once each', () => {
    expect(new Set(SHARE_ERROR_REASONS).size).toBe(SHARE_ERROR_REASONS.length)
    expect(SHARE_ERROR_REASONS).toHaveLength(14)
  })

  it('accepts a listed reason and rejects an invented one', () => {
    expect(ShareErrorReasonSchema.safeParse('self_share').success).toBe(true)
    expect(ShareErrorReasonSchema.safeParse('made_up').success).toBe(false)
  })

  it('keeps reason optional on the error body', () => {
    expect(ShareApiErrorSchema.safeParse({ code: 'not_found', message: 'x' }).success).toBe(true)
    expect(
      ShareApiErrorSchema.safeParse({ code: 'self_share', message: 'x', reason: 'self_share' })
        .success
    ).toBe(true)
    expect(
      ShareApiErrorSchema.safeParse({ code: 'self_share', message: 'x', reason: 'nope' }).success
    ).toBe(false)
  })
})
