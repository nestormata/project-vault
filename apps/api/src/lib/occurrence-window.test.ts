import { describe, expect, it } from 'vitest'
import {
  OCCURRED_AT_FUTURE_SKEW_SECONDS,
  OCCURRED_AT_MAX_AGE_SECONDS,
  OCCURRED_AT_UNATTESTED_MAX_PAST_SECONDS,
  classifyOccurrence,
} from './occurrence-window.js'

/** Story 71.4 D3/D4: the one pure window rule shared by S1 and the write boundary (injected clock). */
const NOW = 1_790_000_000_000

describe('classifyOccurrence', () => {
  it('pins the constants of the signed decisions', () => {
    expect(OCCURRED_AT_FUTURE_SKEW_SECONDS).toBe(30)
    expect(OCCURRED_AT_UNATTESTED_MAX_PAST_SECONDS).toBe(90)
    expect(OCCURRED_AT_MAX_AGE_SECONDS).toBe(2_592_000)
  })

  it.each([
    [-31_000, 'future'],
    [-30_001, 'future'],
    [-30_000, 'ok'],
    [0, 'ok'],
    [89_000, 'ok'],
    [90_000, 'ok'],
    [90_001, 'too_old'],
    [91_000, 'too_old'],
  ])('age %d ms with a 90 s window -> %s', (ageMs, expected) => {
    expect(classifyOccurrence({ occurredAtMs: NOW - ageMs, nowMs: NOW, maxAgeSeconds: 90 })).toBe(
      expected
    )
  })

  it('a wider window admits an older time, and the hard cap bounds any window', () => {
    const days = (n: number) => n * 86_400_000
    const wide = { nowMs: NOW, maxAgeSeconds: 30 * 86_400 }
    expect(classifyOccurrence({ ...wide, occurredAtMs: NOW - days(29) })).toBe('ok')
    expect(classifyOccurrence({ ...wide, occurredAtMs: NOW - days(30) })).toBe('ok')
    expect(classifyOccurrence({ ...wide, occurredAtMs: NOW - days(31) })).toBe('too_old')
    const over = { nowMs: NOW, maxAgeSeconds: 90 * 86_400 }
    expect(classifyOccurrence({ ...over, occurredAtMs: NOW - days(31) })).toBe('too_old')
  })
})
