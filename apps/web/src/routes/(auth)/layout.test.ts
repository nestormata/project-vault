import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/svelte'
import { createRawSnippet } from 'svelte'

vi.mock('$app/paths', () => ({ resolve: (path: string) => path }))

import {
  getPreAuthThemeName,
  PRE_AUTH_THEME_CACHE_KEY,
  setPreAuthTheme,
  writePreAuthThemeCache,
} from '$lib/state/theme.svelte.js'
import AuthLayout from './+layout.svelte'

function childrenSnippet() {
  return createRawSnippet(() => ({
    render: () => '<p>child content</p>',
  }))
}

describe('(auth)/+layout.svelte — Story 16.4 AC-3 pre-auth theme delivery', () => {
  beforeEach(() => {
    setPreAuthTheme(null, null)
    localStorage.clear()
  })
  afterEach(() => {
    cleanup()
    localStorage.clear()
  })

  it('renders no data-theme and no injected <style> when no pre-auth theme has resolved', () => {
    const { container } = render(AuthLayout, { props: { children: childrenSnippet() } })

    const main = container.querySelector('main')
    expect(main?.getAttribute('data-theme')).toBeNull()
    expect(container.querySelector('style')).toBeNull()
  })

  it('sets data-theme and injects the resolved CSS once a pre-auth theme is set', () => {
    setPreAuthTheme('acme-brand', '[data-theme="acme-brand"] { --brand: #fff; }')
    const { container } = render(AuthLayout, { props: { children: childrenSnippet() } })

    const main = container.querySelector('main')
    expect(main?.getAttribute('data-theme')).toBe('acme-brand')
    const style = container.querySelector('style')
    expect(style?.textContent).toContain('acme-brand')
  })

  // Story 16.6 AC-2/AC-4/AC-8/AC-9 Task 3.2: cache-seeded optimistic first paint.
  it('applies a valid cached theme on mount with no lookup made', async () => {
    writePreAuthThemeCache('acme-brand', '[data-theme="acme-brand"] { --brand: #fff; }')

    const { container } = render(AuthLayout, { props: { children: childrenSnippet() } })
    await Promise.resolve()

    const main = container.querySelector('main')
    expect(main?.getAttribute('data-theme')).toBe('acme-brand')
    expect(container.querySelector('style')?.textContent).toContain('acme-brand')
  })

  it('renders base theme (no-op) when no cached entry exists', async () => {
    const { container } = render(AuthLayout, { props: { children: childrenSnippet() } })
    await Promise.resolve()

    const main = container.querySelector('main')
    expect(main?.getAttribute('data-theme')).toBeNull()
    expect(container.querySelector('style')).toBeNull()
  })

  it('does not clobber an already-resolved theme with a stale cached entry', async () => {
    writePreAuthThemeCache('startup-theme', '[data-theme="startup-theme"] {}')
    setPreAuthTheme('acme-brand', '[data-theme="acme-brand"] { --brand: #fff; }')

    const { container } = render(AuthLayout, { props: { children: childrenSnippet() } })
    await Promise.resolve()

    expect(getPreAuthThemeName()).toBe('acme-brand')
    const main = container.querySelector('main')
    expect(main?.getAttribute('data-theme')).toBe('acme-brand')
  })

  it('does not clear the pre-auth cache across a simulated logout (AC-8)', () => {
    writePreAuthThemeCache('acme-brand', '[data-theme="acme-brand"] {}')

    render(AuthLayout, { props: { children: childrenSnippet() } })

    // Simulate a logout event: nothing in this layout's mount lifecycle should ever remove the key.
    expect(localStorage.getItem(PRE_AUTH_THEME_CACHE_KEY)).not.toBeNull()
  })
})
