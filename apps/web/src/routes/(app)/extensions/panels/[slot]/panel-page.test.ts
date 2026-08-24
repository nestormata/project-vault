import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import { routeExists } from '$lib/test/route-exists.js'
import { BASE_EXTENSION_THEME_VARS } from '$lib/security/extension-theme-vars.js'
import ExtensionPanelPage from './+page.svelte'

afterEach(() => cleanup())

const baseData = {
  slot: 'group',
  html: null as string | null,
  themeVars: BASE_EXTENSION_THEME_VARS,
}

describe('/(app)/extensions/panels/[slot] +page.svelte (Story 25.1)', () => {
  it('is a real, existing route', () => {
    expect(routeExists('/extensions/panels/[slot]')).toBe(true)
  })

  it('AC3: renders the calm "temporarily unavailable" message when html is null, never a raw error', () => {
    render(ExtensionPanelPage, { props: { data: { ...baseData, html: null } } })

    expect(screen.getByText(/temporarily unavailable/i)).toBeTruthy()
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('AC4/AC1: renders the composed panel document (CSP + extension html) inside a sandboxed iframe on success', () => {
    render(ExtensionPanelPage, { props: { data: { ...baseData, html: '<p>hello</p>' } } })

    const iframe = document.querySelector('iframe')
    expect(iframe).toBeTruthy()
    const srcdoc = iframe?.getAttribute('srcdoc') ?? ''
    expect(srcdoc).toContain('<meta http-equiv="Content-Security-Policy"')
    expect(srcdoc).toContain('<p>hello</p>')
  })

  it('AC4 — SECURITY: the sandbox attribute is exactly "allow-scripts" and never contains allow-same-origin', () => {
    render(ExtensionPanelPage, { props: { data: { ...baseData, html: '<p>hello</p>' } } })

    const iframe = document.querySelector('iframe')
    const sandbox = iframe?.getAttribute('sandbox') ?? ''
    expect(sandbox).toBe('allow-scripts')
    expect(sandbox).not.toContain('allow-same-origin')
  })

  it('AC5: the iframe title is derived from the slot value', () => {
    render(ExtensionPanelPage, {
      props: { data: { ...baseData, slot: 'document', html: '<p>x</p>' } },
    })

    const iframe = document.querySelector('iframe')
    expect(iframe?.getAttribute('title')).toBe('Extension panel: document')
  })

  it('AC5: two different slots produce two distinguishable iframe title values', () => {
    const { unmount } = render(ExtensionPanelPage, {
      props: { data: { ...baseData, slot: 'group', html: '<p>a</p>' } },
    })
    const firstTitle = document.querySelector('iframe')?.getAttribute('title')
    unmount()

    render(ExtensionPanelPage, {
      props: { data: { ...baseData, slot: 'project-container', html: '<p>b</p>' } },
    })
    const secondTitle = document.querySelector('iframe')?.getAttribute('title')

    expect(firstTitle).toBe('Extension panel: group')
    expect(secondTitle).toBe('Extension panel: project-container')
    expect(firstTitle).not.toBe(secondTitle)
  })

  it('AC5: a near-max-length slot value still produces a valid, non-truncated title', () => {
    const longSlot = 'a'.repeat(64)
    render(ExtensionPanelPage, {
      props: { data: { ...baseData, slot: longSlot, html: '<p>x</p>' } },
    })

    expect(document.querySelector('iframe')?.getAttribute('title')).toBe(
      `Extension panel: ${longSlot}`
    )
  })

  it('AC5: the page heading receives tabindex="-1" and becomes document.activeElement after mount (WAI-ARIA APG SPA-navigation focus pattern)', () => {
    render(ExtensionPanelPage, { props: { data: { ...baseData, html: '<p>x</p>' } } })

    const heading = screen.getByRole('heading', { level: 1 })
    expect(heading.getAttribute('tabindex')).toBe('-1')
    expect(document.activeElement).toBe(heading)
  })

  it('AC5: focus lands on the heading even on the degraded (html: null) path', () => {
    render(ExtensionPanelPage, { props: { data: { ...baseData, html: null } } })

    const heading = screen.getByRole('heading', { level: 1 })
    expect(document.activeElement).toBe(heading)
  })
})
