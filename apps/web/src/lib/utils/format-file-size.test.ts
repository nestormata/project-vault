import { describe, expect, it } from 'vitest'
import { formatFileSize } from './format-file-size.js'

// Story 62-4 AC-4: deterministic, non-localised size text for the chosen import file.
describe('formatFileSize', () => {
  it.each([
    [0, '0 B'],
    [1, '1 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [1229, '1.2 KB'],
    [1024 * 1024 - 1, '1024.0 KB'],
    [1024 * 1024, '1.0 MB'],
    [5.5 * 1024 * 1024, '5.5 MB'],
    [3 * 1024 ** 3, '3072.0 MB'],
  ])('formats %d bytes as %s', (bytes, expected) => {
    expect(formatFileSize(bytes)).toBe(expected)
  })
})
