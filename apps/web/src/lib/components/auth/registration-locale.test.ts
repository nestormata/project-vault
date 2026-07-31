import { afterEach, describe, expect, it } from 'vitest'
import {
  consumeRegistrationLocalePending,
  markRegistrationLocalePending,
} from './registration-locale.js'

describe('registration locale handoff', () => {
  afterEach(() => sessionStorage.clear())

  it('marks the completed registration for the next authenticated login', () => {
    markRegistrationLocalePending()

    expect(consumeRegistrationLocalePending()).toBe(true)
    expect(consumeRegistrationLocalePending()).toBe(false)
  })

  it('does nothing when browser session storage is unavailable', () => {
    const original = globalThis.sessionStorage
    Object.defineProperty(globalThis, 'sessionStorage', { value: undefined, configurable: true })

    expect(() => markRegistrationLocalePending()).not.toThrow()
    expect(consumeRegistrationLocalePending()).toBe(false)

    Object.defineProperty(globalThis, 'sessionStorage', { value: original, configurable: true })
  })
})
