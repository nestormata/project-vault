// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { getAppliedTheme, setAppliedTheme, setInitialAppliedTheme } from './theme.svelte.js'

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
