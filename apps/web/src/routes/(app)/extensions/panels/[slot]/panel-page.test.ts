import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import { routeExists } from '$lib/test/route-exists.js'
import ExtensionPanelPage from './+page.svelte'

afterEach(() => cleanup())

describe('/(app)/extensions/panels/[slot] +page.svelte (Story 25.1)', () => {
  it('is a real, existing route', () => {
    expect(routeExists('/extensions/panels/[slot]')).toBe(true)
  })

  it('AC3: renders the calm "temporarily unavailable" message when html is null, never a raw error', () => {
    render(ExtensionPanelPage, { props: { data: { slot: 'group', html: null } } })

    expect(screen.getByText(/temporarily unavailable/i)).toBeTruthy()
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('AC4: renders the panel html inside a sandboxed iframe on success', () => {
    render(ExtensionPanelPage, { props: { data: { slot: 'group', html: '<p>hello</p>' } } })

    const iframe = document.querySelector('iframe')
    expect(iframe).toBeTruthy()
    expect(iframe?.getAttribute('srcdoc')).toBe('<p>hello</p>')
  })

  it('AC4 — SECURITY: the sandbox attribute is exactly "allow-scripts" and never contains allow-same-origin', () => {
    render(ExtensionPanelPage, { props: { data: { slot: 'group', html: '<p>hello</p>' } } })

    const iframe = document.querySelector('iframe')
    const sandbox = iframe?.getAttribute('sandbox') ?? ''
    expect(sandbox).toBe('allow-scripts')
    expect(sandbox).not.toContain('allow-same-origin')
  })
})
