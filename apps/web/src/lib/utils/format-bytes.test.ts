import { describe, expect, it } from 'vitest'
import { formatBytes } from './format-bytes.js'

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
