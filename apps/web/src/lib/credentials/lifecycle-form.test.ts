import { describe, expect, it } from 'vitest'
import { lifecycleDateInputToIso, toLifecycleDateInputValue } from './lifecycle-form.js'

describe('toLifecycleDateInputValue', () => {
  it('slices an ISO datetime down to the YYYY-MM-DD date-input value', () => {
    expect(toLifecycleDateInputValue('2026-07-15T00:00:00.000Z')).toBe('2026-07-15')
  })

  it('returns an empty string for null', () => {
    expect(toLifecycleDateInputValue(null)).toBe('')
  })
})

describe('lifecycleDateInputToIso', () => {
  it('converts a date-input value to a midnight-UTC ISO datetime', () => {
    expect(lifecycleDateInputToIso('2026-12-01')).toBe('2026-12-01T00:00:00.000Z')
  })

  // AC-L1 edge: clearing the expiry date input must reach the server as an explicit null, not
  // an empty string or an omitted field, so "clear" is reachable and distinct from "unchanged".
  it('AC-L1 edge: converts a blank value to null (explicit clear)', () => {
    expect(lifecycleDateInputToIso('')).toBeNull()
  })
})
