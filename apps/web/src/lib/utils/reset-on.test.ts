import { describe, expect, it } from 'vitest'
import { resetOn, withItem } from './reset-on.js'

describe('resetOn', () => {
  it('returns the value unchanged, whatever the identity', () => {
    expect(resetOn('credential-a', null)).toBeNull()
    expect(resetOn('credential-b', 'seed')).toBe('seed')
  })
})

describe('withItem', () => {
  const a = { id: 'a' }
  const b = { id: 'b' }

  it('appends or prepends an item that is not present yet', () => {
    expect(withItem([a], b, 'end')).toEqual([a, b])
    expect(withItem([a], b, 'start')).toEqual([b, a])
  })

  it('does not duplicate an item that a refresh already brought in', () => {
    const items = [a, b]
    const result = withItem(items, { id: 'b' }, 'start')
    expect(result).toEqual([a, b])
    expect(result).not.toBe(items)
  })
})
