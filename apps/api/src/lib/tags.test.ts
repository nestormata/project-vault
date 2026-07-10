import { describe, it, expect } from 'vitest'
import { dedupeTags, normalizeTag, tagDelta } from './tags.js'

describe('normalizeTag', () => {
  it('lowercases a mixed-case tag', () => {
    expect(normalizeTag('Prod')).toBe('prod')
  })

  it('leaves an already-lowercase tag unchanged', () => {
    expect(normalizeTag('payments')).toBe('payments')
  })
})

describe('dedupeTags', () => {
  it('lowercases and collapses mixed-case duplicates (AC-T1)', () => {
    expect(dedupeTags(['Prod', 'PROD', 'staging'])).toEqual(['prod', 'staging'])
  })

  it('collapses two entries differing only by case into one, preserving first-occurrence position', () => {
    expect(dedupeTags(['Prod', 'prod', 'Staging'])).toEqual(['prod', 'staging'])
  })

  it('leaves already-normalized input unchanged (regression — existing lowercase fixtures)', () => {
    expect(dedupeTags(['payments', 'prod'])).toEqual(['payments', 'prod'])
  })

  it('returns an empty array unchanged', () => {
    expect(dedupeTags([])).toEqual([])
  })
})

describe('tagDelta', () => {
  it('is unmodified case-sensitive comparison, but is a no-op once both sides are normalized (AC-T3)', () => {
    expect(tagDelta(['prod'], dedupeTags(['Prod']))).toEqual({ added: [], removed: [] })
  })

  it('still reports a genuine change alongside a case-only one', () => {
    expect(tagDelta(['prod', 'legacy'], dedupeTags(['Prod', 'staging']))).toEqual({
      added: ['staging'],
      removed: ['legacy'],
    })
  })
})
