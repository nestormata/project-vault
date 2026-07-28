import { describe, expect, it } from 'vitest'
import { THEME_TOKENS } from './theme-tokens.js'
import type { ThemeTokenDefinition, ThemeTokenKey } from './theme-tokens.js'

describe('THEME_TOKENS', () => {
  it('declares at least one token of each supported type (color, length, enum)', () => {
    const types = new Set(Object.values(THEME_TOKENS).map((def) => def.type))
    expect(types).toContain('color')
    expect(types).toContain('length')
    expect(types).toContain('enum')
  })

  it('every enum token declares a non-empty list of allowed values', () => {
    for (const [key, def] of Object.entries(THEME_TOKENS)) {
      if (def.type !== 'enum') continue
      expect(Array.isArray(def.values), `${key}.values must be an array`).toBe(true)
      expect(def.values.length, `${key}.values must not be empty`).toBeGreaterThan(0)
    }
  })

  it('every token key is a non-empty camelCase string', () => {
    for (const key of Object.keys(THEME_TOKENS)) {
      expect(key).toMatch(/^[a-z][a-zA-Z0-9]*$/)
    }
  })

  it('color/length tokens carry only a type field, no stray values array', () => {
    for (const [key, def] of Object.entries(THEME_TOKENS)) {
      if (def.type === 'enum') continue
      expect(Object.keys(def), key).toEqual(['type'])
    }
  })

  it('exports a derived ThemeTokenKey type usable as a registry key lookup', () => {
    function assertKey(key: ThemeTokenKey): ThemeTokenKey {
      return key
    }
    for (const key of Object.keys(THEME_TOKENS) as ThemeTokenKey[]) {
      expect(assertKey(key)).toBe(key)
    }
  })

  it('type helper ThemeTokenDefinition accepts every registry entry shape', () => {
    const sample: ThemeTokenDefinition = { type: 'color' }
    expect(sample.type).toBe('color')
  })

  it('includes the canonical example tokens referenced in Story 16.1 ACs', () => {
    expect(THEME_TOKENS.colorPrimary600).toEqual({ type: 'color' })
    expect(THEME_TOKENS.radiusMd).toEqual({ type: 'length' })
    expect(THEME_TOKENS.fontWeightBody).toMatchObject({ type: 'enum' })
    expect(THEME_TOKENS.fontWeightBody.values).toEqual(['normal', 'medium', 'bold'])
  })
})
