// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getAppliedTheme,
  getPreAuthThemeCss,
  getPreAuthThemeName,
  isSafeCachedThemeCss,
  PRE_AUTH_THEME_CACHE_KEY,
  PRE_AUTH_THEME_CACHE_TTL_MS,
  readPreAuthThemeCache,
  seedPreAuthThemeFromCache,
  setAppliedTheme,
  setInitialAppliedTheme,
  setPreAuthTheme,
  writePreAuthThemeCache,
} from './theme.svelte.js'

describe('theme.svelte.ts (Story 16.2 AC-2/AC-6)', () => {
  it('starts at null (base theme) until seeded', () => {
    setInitialAppliedTheme(null)
    expect(getAppliedTheme()).toBeNull()
  })

  it('setInitialAppliedTheme seeds the applied theme from server-loaded data', () => {
    setInitialAppliedTheme('acme-brand')
    expect(getAppliedTheme()).toBe('acme-brand')
  })

  it('setAppliedTheme updates the shared state so every reader sees the new value immediately', () => {
    setInitialAppliedTheme('acme-brand')
    setAppliedTheme(null)
    expect(getAppliedTheme()).toBeNull()
  })
})

// Story 16.6 AC-1/AC-2/AC-3/AC-4: localStorage-backed pre-auth theme cache.
describe('pre-auth theme cache (Story 16.6)', () => {
  beforeEach(() => {
    localStorage.clear()
    setPreAuthTheme(null, null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
    setPreAuthTheme(null, null)
  })

  describe('isSafeCachedThemeCss (AC-2 security edge)', () => {
    it('allows plain, benign CSS', () => {
      expect(isSafeCachedThemeCss('[data-theme="acme-brand"] { --brand: #fff; }')).toBe(true)
    })

    it('allows a data: url() reference', () => {
      expect(isSafeCachedThemeCss('.x { background: url(data:image/png;base64,AAA=); }')).toBe(true)
    })

    it('allows an https: url() reference', () => {
      expect(isSafeCachedThemeCss('.x { background: url(https://cdn.example.com/a.png); }')).toBe(
        true
      )
    })

    it.each([
      ['expression(', '.x { width: expression(alert(1)); }'],
      ['@import', '@import url(evil.css);'],
      ['javascript:', '.x { background: url(javascript:alert(1)); }'],
      ['<script', '<script>alert(1)</script>'],
      ['behavior:', '.x { behavior: url(evil.htc); }'],
      ['non-data/https url()', '.x { background: url(http://evil.example.com/a.png); }'],
    ])('rejects CSS containing %s', (_label, css) => {
      expect(isSafeCachedThemeCss(css)).toBe(false)
    })
  })

  describe('writePreAuthThemeCache (AC-1)', () => {
    it('writes name/css/savedAt to localStorage', () => {
      writePreAuthThemeCache('acme-brand', '[data-theme="acme-brand"] {}')
      const raw = localStorage.getItem(PRE_AUTH_THEME_CACHE_KEY)
      expect(raw).not.toBeNull()
      const parsed = JSON.parse(raw as string)
      expect(parsed.name).toBe('acme-brand')
      expect(parsed.css).toBe('[data-theme="acme-brand"] {}')
      expect(typeof parsed.savedAt).toBe('number')
    })

    it('swallows a thrown error when storage is unavailable', () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('quota exceeded')
      })
      expect(() => writePreAuthThemeCache('acme-brand', 'css')).not.toThrow()
    })
  })

  describe('readPreAuthThemeCache (AC-2/AC-4)', () => {
    it('round-trips a freshly written entry', () => {
      writePreAuthThemeCache('acme-brand', '[data-theme="acme-brand"] {}')
      expect(readPreAuthThemeCache()).toEqual({
        name: 'acme-brand',
        css: '[data-theme="acme-brand"] {}',
      })
    })

    it('returns null when no cached entry exists', () => {
      expect(readPreAuthThemeCache()).toBeNull()
    })

    it('ignores and removes a malformed JSON entry', () => {
      localStorage.setItem(PRE_AUTH_THEME_CACHE_KEY, '{not json')
      expect(readPreAuthThemeCache()).toBeNull()
      expect(localStorage.getItem(PRE_AUTH_THEME_CACHE_KEY)).toBeNull()
    })

    it('ignores and removes an entry missing required fields', () => {
      localStorage.setItem(PRE_AUTH_THEME_CACHE_KEY, JSON.stringify({ name: 'acme-brand' }))
      expect(readPreAuthThemeCache()).toBeNull()
      expect(localStorage.getItem(PRE_AUTH_THEME_CACHE_KEY)).toBeNull()
    })

    it('ignores and removes an expired entry (older than 7 days)', () => {
      localStorage.setItem(
        PRE_AUTH_THEME_CACHE_KEY,
        JSON.stringify({
          name: 'acme-brand',
          css: '.x {}',
          savedAt: Date.now() - (PRE_AUTH_THEME_CACHE_TTL_MS + 1000),
        })
      )
      expect(readPreAuthThemeCache()).toBeNull()
      expect(localStorage.getItem(PRE_AUTH_THEME_CACHE_KEY)).toBeNull()
    })

    it('treats a future savedAt (clock skew) as not expired', () => {
      localStorage.setItem(
        PRE_AUTH_THEME_CACHE_KEY,
        JSON.stringify({ name: 'acme-brand', css: '.x {}', savedAt: Date.now() + 60_000 })
      )
      expect(readPreAuthThemeCache()).toEqual({ name: 'acme-brand', css: '.x {}' })
    })

    it('ignores and removes an entry whose CSS fails the safety check', () => {
      localStorage.setItem(
        PRE_AUTH_THEME_CACHE_KEY,
        JSON.stringify({
          name: 'acme-brand',
          css: '.x { width: expression(alert(1)); }',
          savedAt: Date.now(),
        })
      )
      expect(readPreAuthThemeCache()).toBeNull()
      expect(localStorage.getItem(PRE_AUTH_THEME_CACHE_KEY)).toBeNull()
    })
  })

  describe('seedPreAuthThemeFromCache (AC-2)', () => {
    it('applies a valid cached entry via setPreAuthTheme when runes are still null', () => {
      writePreAuthThemeCache('acme-brand', '[data-theme="acme-brand"] {}')
      seedPreAuthThemeFromCache()
      expect(getPreAuthThemeName()).toBe('acme-brand')
      expect(getPreAuthThemeCss()).toBe('[data-theme="acme-brand"] {}')
    })

    it('is a no-op when no cached entry exists', () => {
      seedPreAuthThemeFromCache()
      expect(getPreAuthThemeName()).toBeNull()
      expect(getPreAuthThemeCss()).toBeNull()
    })

    it('is a no-op (race guard) when a resolution already set a non-null theme', () => {
      writePreAuthThemeCache('acme-brand', '[data-theme="acme-brand"] {}')
      setPreAuthTheme('startup-theme', '[data-theme="startup-theme"] {}')
      seedPreAuthThemeFromCache()
      expect(getPreAuthThemeName()).toBe('startup-theme')
      expect(getPreAuthThemeCss()).toBe('[data-theme="startup-theme"] {}')
    })
  })
})
