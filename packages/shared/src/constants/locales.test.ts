import { describe, expect, it } from 'vitest'
import { SUPPORTED_LOCALES, SUPPORTED_LOCALE_DISPLAY_NAMES, isSupportedLocale } from './locales.js'

describe('SUPPORTED_LOCALES', () => {
  it('is exactly en and es for this story', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en', 'es'])
  })

  it('has a display name for every supported locale', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(SUPPORTED_LOCALE_DISPLAY_NAMES[locale]).toBeTruthy()
    }
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
