import { describe, expect, it } from 'vitest'
import type { EphemeralStateHost } from './ephemeral-state.js'

describe('EphemeralStateHost — AC-1 exact shape (Story 20.8)', () => {
  it('exposes exactly get/set/delete/compareAndSwap/compareAndDelete — no orgId parameter on any method', () => {
    const fixture: EphemeralStateHost = {
      set: async (_key: string, _value: string, _ttlSeconds: number) => undefined,
      get: async (_key: string) => undefined,
      delete: async (_key: string) => undefined,
      compareAndSwap: async (
        _key: string,
        _expectedValue: string | null,
        _newValue: string,
        _ttlSeconds: number
      ) => true,
      compareAndDelete: async (_key: string, _expectedValue: string) => true,
    }
    expect(new Set(Object.keys(fixture))).toEqual(
      new Set(['set', 'get', 'delete', 'compareAndSwap', 'compareAndDelete'])
    )
  })

  it('set() resolves to void/undefined, get() resolves to string | undefined', async () => {
    const fixture: EphemeralStateHost = {
      set: async () => undefined,
      get: async () => 'a-value',
      delete: async () => undefined,
      compareAndSwap: async () => true,
      compareAndDelete: async () => false,
    }
    await expect(fixture.set('k', 'v', 60)).resolves.toBeUndefined()
    await expect(fixture.get('k')).resolves.toBe('a-value')
  })

  it('compareAndSwap() and compareAndDelete() both resolve to a boolean', async () => {
    const fixture: EphemeralStateHost = {
      set: async () => undefined,
      get: async () => undefined,
      delete: async () => undefined,
      compareAndSwap: async () => false,
      compareAndDelete: async () => true,
    }
    await expect(fixture.compareAndSwap('k', null, 'v', 60)).resolves.toBe(false)
    await expect(fixture.compareAndDelete('k', 'expected')).resolves.toBe(true)
  })
})
