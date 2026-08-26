import { describe, it, expect } from 'vitest'
import { resolveTrustProxy } from './trust-proxy.js'

describe('resolveTrustProxy', () => {
  it('returns false when trust proxy is disabled, regardless of hop count', () => {
    expect(resolveTrustProxy(false, 1)).toBe(false)
    expect(resolveTrustProxy(false, 3)).toBe(false)
  })

  it('trusts hops strictly less than the configured count when enabled', () => {
    const fn = resolveTrustProxy(true, 1)
    expect(fn).not.toBe(false)
    if (fn === false) throw new Error('unreachable')
    expect(fn('1.2.3.4', 0)).toBe(true)
    expect(fn('1.2.3.4', 1)).toBe(false)
    expect(fn('1.2.3.4', 2)).toBe(false)
  })

  it('extends trust across multiple configured hops', () => {
    const fn = resolveTrustProxy(true, 3)
    expect(fn).not.toBe(false)
    if (fn === false) throw new Error('unreachable')
    expect(fn('1.2.3.4', 0)).toBe(true)
    expect(fn('1.2.3.4', 1)).toBe(true)
    expect(fn('1.2.3.4', 2)).toBe(true)
    expect(fn('1.2.3.4', 3)).toBe(false)
  })
})
