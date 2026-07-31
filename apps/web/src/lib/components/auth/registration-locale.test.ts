import { afterEach, describe, expect, it } from 'vitest'
import {
  consumeRegistrationLocalePending,
  markRegistrationLocalePending,
} from './registration-locale.js'

describe('registration locale handoff', () => {
  afterEach(() => globalThis.sessionStorage?.clear())

  it('marks the completed registration for the next authenticated login', () => {
    markRegistrationLocalePending('u1', 'es')

    expect(consumeRegistrationLocalePending('u1')).toBe('es')
    expect(consumeRegistrationLocalePending('u1')).toBeNull()
  })

  it('does not apply a registration handoff to a different authenticated user', () => {
    markRegistrationLocalePending('u1', 'es')

    expect(consumeRegistrationLocalePending('u2')).toBeNull()
    expect(consumeRegistrationLocalePending('u1')).toBe('es')
  })

  it('does nothing when browser session storage is unavailable', () => {
    const original = globalThis.sessionStorage
    Object.defineProperty(globalThis, 'sessionStorage', { value: undefined, configurable: true })

    try {
      expect(() => markRegistrationLocalePending('u1', 'es')).not.toThrow()
      expect(consumeRegistrationLocalePending('u1')).toBe('es')
    } finally {
      Object.defineProperty(globalThis, 'sessionStorage', { value: original, configurable: true })
    }
  })
})
