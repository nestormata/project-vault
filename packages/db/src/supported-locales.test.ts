import { describe, expect, it } from 'vitest'
import { SUPPORTED_LOCALES, isSupportedLocale } from './supported-locales.js'

describe('SUPPORTED_LOCALES', () => {
  it('is exactly en and es for this story', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en', 'es'])
  })
})

describe('isSupportedLocale', () => {
  it.each(SUPPORTED_LOCALES)('accepts %s', (locale) => {
    expect(isSupportedLocale(locale)).toBe(true)
  })

  it('rejects an unsupported locale code', () => {
    expect(isSupportedLocale('xx')).toBe(false)
  })

  it('rejects a regional variant not in the compiled set', () => {
    expect(isSupportedLocale('en-US')).toBe(false)
  })

  it('rejects non-string values without throwing', () => {
    expect(isSupportedLocale(undefined)).toBe(false)
    expect(isSupportedLocale(null)).toBe(false)
    expect(isSupportedLocale(42)).toBe(false)
  })
})
