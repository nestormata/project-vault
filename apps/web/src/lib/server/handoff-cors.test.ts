import { describe, expect, it } from 'vitest'
import { corsResponseHeaders, isOriginAllowed, parseAllowedOrigins } from './handoff-cors.js'

describe('parseAllowedOrigins', () => {
  it('splits a comma-separated list and trims whitespace', () => {
    expect(parseAllowedOrigins('https://a.example, https://b.example ,https://c.example')).toEqual(
      new Set(['https://a.example', 'https://b.example', 'https://c.example'])
    )
  })

  it('drops empty segments', () => {
    expect(parseAllowedOrigins('https://a.example,,')).toEqual(new Set(['https://a.example']))
  })

  it('returns an empty set for undefined input', () => {
    expect(parseAllowedOrigins(undefined)).toEqual(new Set())
  })

  it('returns an empty set for an empty string', () => {
    expect(parseAllowedOrigins('')).toEqual(new Set())
  })

  // Story 60.7 AC1: Compose appends operator CORS_EXTRA_ORIGINS to PV's own origin; a `null`
  // entry (the Origin browsers send from sandboxed iframes and file:// pages) must never match.
  it('drops a null entry, case-insensitively', () => {
    expect(parseAllowedOrigins('https://vault.example.test,null')).toEqual(
      new Set(['https://vault.example.test'])
    )
    expect(parseAllowedOrigins('https://vault.example.test, NULL ').size).toBe(1)
  })

  // Story 60.7 AC1: mirrors env.ts's no-wildcard rule; `*` is never an allowlist entry here.
  it('drops a wildcard entry', () => {
    expect(parseAllowedOrigins('https://vault.example.test,*')).toEqual(
      new Set(['https://vault.example.test'])
    )
  })
})

describe('isOriginAllowed', () => {
  const allowed = parseAllowedOrigins('https://cm.example')

  it('allows an origin present in the set', () => {
    expect(isOriginAllowed('https://cm.example', allowed)).toBe(true)
  })

  it('rejects an origin absent from the set', () => {
    expect(isOriginAllowed('https://attacker.example', allowed)).toBe(false)
  })

  it('rejects a null origin (no Origin header sent at all)', () => {
    expect(isOriginAllowed(null, allowed)).toBe(false)
  })

  it("rejects the literal 'null' Origin even when the configured list contains null", () => {
    expect(isOriginAllowed('null', parseAllowedOrigins('https://cm.example,null'))).toBe(false)
  })

  it("rejects a literal '*' Origin even when the configured list contains *", () => {
    expect(isOriginAllowed('*', parseAllowedOrigins('https://cm.example,*'))).toBe(false)
  })
})

describe('corsResponseHeaders', () => {
  it('echoes the exact matched origin, never a wildcard', () => {
    expect(corsResponseHeaders('https://cm.example')).toEqual({
      'Access-Control-Allow-Origin': 'https://cm.example',
      'Access-Control-Allow-Credentials': 'true',
      Vary: 'Origin',
    })
  })
})
