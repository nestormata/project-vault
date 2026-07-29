import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/svelte'
import { createRawSnippet } from 'svelte'

vi.mock('$app/paths', () => ({ resolve: (path: string) => path }))

import { setPreAuthTheme } from '$lib/state/theme.svelte.js'
import AuthLayout from './+layout.svelte'

function childrenSnippet() {
  return createRawSnippet(() => ({
    render: () => '<p>child content</p>',
  }))
}

describe('(auth)/+layout.svelte — Story 16.4 AC-3 pre-auth theme delivery', () => {
  beforeEach(() => {
    setPreAuthTheme(null, null)
  })
  afterEach(() => cleanup())

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
})
