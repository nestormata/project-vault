import { describe, expect, it } from 'vitest'
import { nth, serializeWithoutNoise } from './dom.js'

describe('nth (Story 68.1 Q2)', () => {
  it('returns the element at a positive or negative index', () => {
    expect(nth(['a', 'b', 'c'], 0)).toBe('a')
    expect(nth(['a', 'b', 'c'], -1)).toBe('c')
  })

  it('throws when there is no element at that index', () => {
    expect(() => nth([], 0)).toThrow('expected an element at index 0 of 0')
  })
})

describe('serializeWithoutNoise (parser-based, replaces regex stripping)', () => {
  const host = (html: string): HTMLElement => {
    const el = document.createElement('div')
    el.innerHTML = html
    return el
  }

  it('drops comment nodes, including nested and unterminated-looking ones', () => {
    expect(serializeWithoutNoise(host('<p>a<!-- x --></p><!--<!-- y -->--><b>c</b>'))).toBe(
      '<p>a</p>--&gt;<b>c</b>'
    )
  })

  it('empties script elements but keeps the tag, and leaves the source node untouched', () => {
    const el = host('<script>alert(1)</script><i>k</i><!-- c -->')
    expect(serializeWithoutNoise(el)).toBe('<script></script><i>k</i>')
    expect(el.innerHTML).toBe('<script>alert(1)</script><i>k</i><!-- c -->')
  })
})
