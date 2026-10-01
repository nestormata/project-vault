import { describe, expect, it } from 'vitest'
import { nth } from './dom.js'

describe('nth (Story 68.1 Q2)', () => {
  it('returns the element at a positive or negative index', () => {
    expect(nth(['a', 'b', 'c'], 0)).toBe('a')
    expect(nth(['a', 'b', 'c'], -1)).toBe('c')
  })

  it('throws when there is no element at that index', () => {
    expect(() => nth([], 0)).toThrow('expected an element at index 0 of 0')
  })
})
