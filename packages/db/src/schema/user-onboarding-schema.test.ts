import { describe, expect, it } from 'vitest'
import { EXCLUDED_TABLES } from '../check-rls-coverage.js'

describe('user_onboarding schema', () => {
  it('is excluded from RLS coverage checks', () => {
    expect(EXCLUDED_TABLES.has('user_onboarding')).toBe(true)
  })
})
