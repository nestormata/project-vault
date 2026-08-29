import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import { routeExists } from '$lib/test/route-exists.js'
import { BASE_EXTENSION_THEME_VARS } from '$lib/security/extension-theme-vars.js'

const gotoMock = vi.hoisted(() => vi.fn())
vi.mock('$app/navigation', () => ({ goto: gotoMock }))

import ExtensionPanelPage from './+page.svelte'

afterEach(() => {
  cleanup()
  gotoMock.mockReset()
})

// Story 25.12 AC2 — matches the legacy DEFAULT_PANEL_DATA_PATHS pair every test not exercising
// the new manifest-declared-list behavior expects, so pre-existing project-container data-relay
// tests below keep exercising the exact same effective allowlist they always have.
const baseData = {
  slot: 'group',
  html: null as string | null,
  themeVars: BASE_EXTENSION_THEME_VARS,
  allowedDataPaths: ['/api/v1/projects', '/api/v1/projects/:id'],
}

// Story 29.1 — the panel's HTML now renders into this plain, same-origin `<div>` (the
// `use:renderPanelHtml` container), never an `<iframe>`. Every test below that used to assert on
// `document.querySelector('iframe')` now asserts on this container instead.
function panelContainer(): HTMLElement | null {
  return document.querySelector('.mt-6.overflow-hidden.rounded-2xl.border.border-slate-200')
}

describe('/(app)/extensions/panels/[slot] +page.svelte (Story 25.1, rewired inline by Story 29.1)', () => {
  it('is a real, existing route', () => {
    expect(routeExists('/extensions/panels/[slot]/[...subpath]')).toBe(true)
  })

  it('AC5: renders the calm "temporarily unavailable" message when html is null, never a raw error', () => {
    render(ExtensionPanelPage, { props: { data: { ...baseData, html: null } } })

    expect(screen.getByText(/temporarily unavailable/i)).toBeTruthy()
    expect(document.querySelector('iframe')).toBeNull()
    expect(panelContainer()).toBeNull()
  })

  it('AC1/AC2/AC3/AC9: renders the panel html directly into a same-document container element, no iframe/srcdoc/{@html} involved', () => {
    render(ExtensionPanelPage, { props: { data: { ...baseData, html: '<p>hello</p>' } } })

    expect(document.querySelector('iframe')).toBeNull()
    const container = panelContainer()
    expect(container).toBeTruthy()
    expect(container?.innerHTML).toContain('hello')
    expect(container?.tagName).toBe('DIV')
  })

  it('AC16(c): an empty string data.html renders an empty, harmless container — distinct from the null degraded state', () => {
    render(ExtensionPanelPage, { props: { data: { ...baseData, html: '' } } })

    expect(screen.queryByText(/temporarily unavailable/i)).toBeNull()
    const container = panelContainer()
    expect(container).toBeTruthy()
    expect(container?.innerHTML).toBe('')
  })

  it('AC4: malicious html (script tag + onerror handler) is stripped before it ever reaches the DOM', () => {
    render(ExtensionPanelPage, {
      props: {
        data: {
          ...baseData,
          html: '<p>hi</p><img src=x onerror="window.__pwned=true"><script>window.__pwned2=true</script>',
        },
      },
    })

    const container = panelContainer()
    expect(container?.querySelector('script')).toBeNull()
    expect(container?.querySelector('img')?.getAttribute('onerror')).toBeNull()
  })

  it('AC6: the panel container carries the resolved --pv-ext-* theme vars as inline custom properties', () => {
    render(ExtensionPanelPage, { props: { data: { ...baseData, html: '<p>x</p>' } } })

    const container = panelContainer()
    const style = container?.getAttribute('style') ?? ''
    expect(style).toContain('--pv-ext-surface')
    expect(style).toContain(BASE_EXTENSION_THEME_VARS['--pv-ext-surface'])
    expect(style).toContain('--pv-ext-ink')
    expect(style).toContain('--pv-ext-brand')
    expect(style).toContain('--pv-ext-line')
    expect(style).toContain('--pv-ext-muted')
  })

  it('AC10: the page heading receives tabindex="-1" and becomes document.activeElement after mount (WAI-ARIA APG SPA-navigation focus pattern)', () => {
    render(ExtensionPanelPage, { props: { data: { ...baseData, html: '<p>x</p>' } } })

    const heading = screen.getByRole('heading', { level: 1 })
    expect(heading.getAttribute('tabindex')).toBe('-1')
    expect(document.activeElement).toBe(heading)
  })

  it('AC10: focus lands on the heading even on the degraded (html: null) path', () => {
    render(ExtensionPanelPage, { props: { data: { ...baseData, html: null } } })

    const heading = screen.getByRole('heading', { level: 1 })
    expect(document.activeElement).toBe(heading)
  })

  it('AC10 — code-review regression: focus moves to the heading again on a soft (SPA) navigation between slots, not just on initial mount', async () => {
    // SvelteKit reuses this same component instance across client-side navigations between
    // different `[slot]` values — unlike an `unmount()`-between-renders test, this exercises the
    // real "same instance, props change" shape a soft navigation actually takes.
    const { rerender } = render(ExtensionPanelPage, {
      props: { data: { ...baseData, slot: 'group', html: '<p>a</p>' } },
    })
    const heading = screen.getByRole('heading', { level: 1 })
    expect(document.activeElement).toBe(heading)

    // Simulate focus having moved elsewhere (e.g. the user tabbed into the previous panel).
    heading.blur()
    expect(document.activeElement).not.toBe(heading)

    await rerender({ data: { ...baseData, slot: 'project-container', html: '<p>b</p>' } })

    expect(document.activeElement).toBe(heading)
    expect(panelContainer()?.innerHTML).toContain('b')
  })

  it('rapid successive slot navigations each render correctly with no leaked prior content', async () => {
    const { rerender } = render(ExtensionPanelPage, {
      props: { data: { ...baseData, slot: 'a', html: '<p>slot-a</p>' } },
    })
    await rerender({ data: { ...baseData, slot: 'b', html: '<p>slot-b</p>' } })
    await rerender({ data: { ...baseData, slot: 'c', html: '<p>slot-c</p>' } })

    const container = panelContainer()
    expect(container?.innerHTML).toContain('slot-c')
    expect(container?.innerHTML).not.toContain('slot-a')
    expect(container?.innerHTML).not.toContain('slot-b')
  })

  it('a back-navigation to the degraded (html: null) state removes the container cleanly, no stale content left behind', async () => {
    const { rerender } = render(ExtensionPanelPage, {
      props: { data: { ...baseData, html: '<p>state-a</p>' } },
    })
    expect(panelContainer()).toBeTruthy()

    await rerender({ data: { ...baseData, html: null } })

    expect(panelContainer()).toBeNull()
    expect(screen.getByText(/temporarily unavailable/i)).toBeTruthy()
  })

  // Story 29.1 AC8 — the three postMessage relays below (`PANEL_ACTION_REQUEST_SOURCE`,
  // `PANEL_DATA_REQUEST_SOURCE`, `PANEL_NAV_REQUEST_SOURCE`) are left in the component's source,
  // untouched and not deleted, pending Stories 29.2/29.4/29.6 replacing them with direct
  // same-origin calls against the new inline DOM. They are now provably INERT: the relay's
  // `event.source !== panelIframe?.contentWindow` identity check can never match any more, since
  // there is no iframe to bind `panelIframe`, so no `postMessage` this test dispatches can ever
  // reach the relay's fetch/goto logic. This is a regression test for that inertness, not a
  // resurrection of the old iframe-sourced relay tests (which asserted the relay's now-removed
  // active behavior).
  describe('Story 29.1 AC8: the postMessage relays are inert (no iframe exists to originate a message from)', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('a data-request-shaped message from window itself never triggers a fetch or a postMessage reply', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      render(ExtensionPanelPage, {
        props: { data: { ...baseData, slot: 'project-container', html: '<p>x</p>' } },
      })

      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            source: 'pv-extension-panel-data-request',
            requestId: 'req-1',
            method: 'GET',
            path: '/api/v1/projects',
          },
        })
      )

      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('an action-request-shaped message never triggers a fetch to actionEndpoint', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      render(ExtensionPanelPage, {
        props: {
          data: {
            ...baseData,
            html: '<p>x</p>',
            actionEndpoint: '/api/v1/extensions/panels/group/actions',
          },
        },
      })

      window.dispatchEvent(
        new MessageEvent('message', {
          data: { source: 'pv-extension-panel-action', requestId: 'r1', kind: 'test-action' },
        })
      )

      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('a navigation-request-shaped message never triggers the authorization fetch or goto()', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      render(ExtensionPanelPage, {
        props: { data: { ...baseData, html: '<p>x</p>' } },
      })

      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            source: 'pv-extension-panel-navigation-request',
            requestId: 'nav-1',
            kind: 'pv-project-detail',
            projectId: 'proj_123',
          },
        })
      )

      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(fetchMock).not.toHaveBeenCalled()
      expect(gotoMock).not.toHaveBeenCalled()
    })
  })
})
