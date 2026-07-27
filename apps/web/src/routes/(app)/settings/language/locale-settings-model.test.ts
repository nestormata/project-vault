import { describe, expect, it } from 'vitest'
import {
  buildLocaleOptions,
  localeToApplyFromActionResult,
  resolveDisplayedLocale,
} from './locale-settings-model.js'

describe('buildLocaleOptions (AC 1)', () => {
  it('lists English and Español with the current selection indicated', () => {
    const options = buildLocaleOptions('es')

    expect(options).toEqual([
      { locale: 'en', label: 'English', isCurrent: false },
      { locale: 'es', label: 'Español', isCurrent: true },
    ])
  })

  it('marks no option current when the stored value is not in the compiled set', () => {
    const options = buildLocaleOptions('xx')
    expect(options.every((option) => !option.isCurrent)).toBe(true)
  })
})

describe('resolveDisplayedLocale (AC 7 edge)', () => {
  it('returns the value unchanged when it is a supported locale', () => {
    expect(resolveDisplayedLocale('es')).toBe('es')
  })

  it('falls back to en for a garbage/stale value', () => {
    expect(resolveDisplayedLocale('xx')).toBe('en')
    expect(resolveDisplayedLocale('')).toBe('en')
    expect(resolveDisplayedLocale('en-US')).toBe('en')
  })
})

describe('localeToApplyFromActionResult (AC 2/9 — fail-closed client ordering)', () => {
  it('returns the locale on a successful result carrying it', () => {
    expect(localeToApplyFromActionResult({ type: 'success', data: { locale: 'es' } })).toBe('es')
  })

  it('returns null for a failure result (never optimistically switches)', () => {
    expect(
      localeToApplyFromActionResult({ type: 'failure', data: { error: 'Unsupported locale' } })
    ).toBeNull()
  })

  it('returns null for a missing/undefined result', () => {
    expect(localeToApplyFromActionResult(null)).toBeNull()
    expect(localeToApplyFromActionResult(undefined)).toBeNull()
  })

  it('returns null when the success payload carries no valid locale', () => {
    expect(localeToApplyFromActionResult({ type: 'success', data: {} })).toBeNull()
    expect(localeToApplyFromActionResult({ type: 'success', data: { locale: 'xx' } })).toBeNull()
  })
})
