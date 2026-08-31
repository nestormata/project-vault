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
