import { describe, expect, it } from 'vitest'
import { defaultByteInputUnit, formatBytes, parseByteInput } from './format-bytes.js'

describe('formatBytes', () => {
  it('returns an in-progress message for null', () => {
    expect(formatBytes(null)).toBe('In progress…')
  })

  it('returns "0 B" for exactly zero bytes', () => {
    expect(formatBytes(0)).toBe('0 B')
  })

  it('formats sub-KB byte counts as B', () => {
    expect(formatBytes(512)).toBe('512.0 B')
  })

  it('formats exactly 1024 bytes as 1.0 KB', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
  })

  it('formats MB-scale values', () => {
    expect(formatBytes(1024 * 1024 * 2.5)).toBe('2.5 MB')
  })

  it('formats GB-scale values', () => {
    expect(formatBytes(1024 ** 3 * 1.2)).toBe('1.2 GB')
  })

  it('formats very large TB-scale values', () => {
    expect(formatBytes(1024 ** 4 * 3)).toBe('3.0 TB')
  })
})

// Story 22.3 AC-5: parseByteInput() / defaultByteInputUnit() — formatBytes()'s counterpart for
// the quota edit form's human-friendly input.
describe('parseByteInput', () => {
  it('converts a GB value to an exact byte integer', () => {
    expect(parseByteInput(1, 'GB')).toBe(1024 ** 3)
    expect(parseByteInput(2, 'GB')).toBe(2 * 1024 ** 3)
  })

  it('converts an MB value to an exact byte integer', () => {
    expect(parseByteInput(500, 'MB')).toBe(500 * 1024 ** 2)
  })

  it('rounds a fractional value to the nearest whole byte', () => {
    expect(parseByteInput(1.5, 'MB')).toBe(Math.round(1.5 * 1024 ** 2))
  })

  it('round-trips with formatBytes for a whole-GB value', () => {
    const bytes = parseByteInput(4, 'GB')
    expect(formatBytes(bytes)).toBe('4.0 GB')
  })
})

describe('defaultByteInputUnit', () => {
  it('defaults to GB for an unlimited (null) quota', () => {
    expect(defaultByteInputUnit(null)).toBe('GB')
  })

  it('picks GB for a quota at or above 1 GiB', () => {
    expect(defaultByteInputUnit(1024 ** 3)).toBe('GB')
    expect(defaultByteInputUnit(5 * 1024 ** 3)).toBe('GB')
  })

  it('picks MB for a quota below 1 GiB', () => {
    expect(defaultByteInputUnit(500 * 1024 ** 2)).toBe('MB')
  })
})
