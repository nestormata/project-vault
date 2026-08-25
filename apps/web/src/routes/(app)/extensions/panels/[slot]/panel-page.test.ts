import { afterEach, describe, expect, it, vi } from 'vitest'
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

  it('AC5 — code-review regression: focus moves to the heading again on a soft (SPA) navigation between slots, not just on initial mount', async () => {
    // SvelteKit reuses this same component instance across client-side navigations between
    // different `[slot]` values — unlike the `unmount()`-between-renders test above, this
    // exercises the real "same instance, props change" shape a soft navigation actually takes.
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
    expect(document.querySelector('iframe')?.getAttribute('title')).toBe(
      'Extension panel: project-container'
    )
  })

  describe('Story 14-11/DW-236 — panel data relay (CentralizeMe project-container panel)', () => {
    function dispatchPanelDataRequest(iframe: HTMLIFrameElement, message: Record<string, unknown>) {
      window.dispatchEvent(
        new MessageEvent('message', { data: message, source: iframe.contentWindow as WindowProxy })
      )
    }

    it('relays an allowed GET path to fetch with credentials, and posts the JSON result back', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        status: 200,
        json: () => Promise.resolve({ data: { items: [] } }),
      })
      vi.stubGlobal('fetch', fetchMock)

      render(ExtensionPanelPage, {
        props: { data: { ...baseData, slot: 'project-container', html: '<p>x</p>' } },
      })
      const iframe = document.querySelector('iframe') as HTMLIFrameElement
      const posted: unknown[] = []
      const contentWindow = iframe.contentWindow as unknown as {
        postMessage: typeof window.postMessage
      }
      vi.spyOn(contentWindow, 'postMessage').mockImplementation((data: unknown) => {
        posted.push(data)
      })

      dispatchPanelDataRequest(iframe, {
        source: 'pv-extension-panel-data-request',
        requestId: 'req-1',
        method: 'GET',
        path: '/api/v1/projects',
      })

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/projects',
        expect.objectContaining({ method: 'GET', credentials: 'same-origin' })
      )
      await vi.waitFor(() =>
        expect(posted).toContainEqual(
          expect.objectContaining({
            source: 'pv-extension-panel-data-result',
            requestId: 'req-1',
            ok: true,
            status: 200,
          })
        )
      )
      vi.unstubAllGlobals()
    })

    it('rejects a path outside the host-owned allowlist without ever calling fetch', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      render(ExtensionPanelPage, {
        props: { data: { ...baseData, slot: 'project-container', html: '<p>x</p>' } },
      })
      const iframe = document.querySelector('iframe') as HTMLIFrameElement
      const posted: unknown[] = []
      const contentWindow = iframe.contentWindow as unknown as {
        postMessage: typeof window.postMessage
      }
      vi.spyOn(contentWindow, 'postMessage').mockImplementation((data: unknown) => {
        posted.push(data)
      })

      dispatchPanelDataRequest(iframe, {
        source: 'pv-extension-panel-data-request',
        requestId: 'req-2',
        method: 'DELETE',
        path: '/api/v1/settings',
      })

      await vi.waitFor(() =>
        expect(posted).toContainEqual(
          expect.objectContaining({
            source: 'pv-extension-panel-data-result',
            requestId: 'req-2',
            ok: false,
          })
        )
      )
      expect(fetchMock).not.toHaveBeenCalled()
      vi.unstubAllGlobals()
    })
  })

  describe('Story 25.6 AC5: the message-relay fetch attaches the CSRF token', () => {
    afterEach(() => {
      // Clear every cookie this describe block may have set, so no value leaks between tests.
      document.cookie = 'csrf-token=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'
      document.cookie = '__Host-csrf-token=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'
      vi.unstubAllGlobals()
    })

    function dispatchPanelActionMessage(iframe: HTMLIFrameElement, kind = 'test-action') {
      const event = new MessageEvent('message', {
        data: { source: 'pv-extension-panel-action', requestId: 'req-1', kind },
      })
      Object.defineProperty(event, 'source', { value: iframe.contentWindow })
      window.dispatchEvent(event)
    }

    it('reads the CSRF cookie value and echoes it as the x-csrf-token request header', async () => {
      document.cookie = 'csrf-token=cookie-csrf-value; path=/'
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ message: 'ok' }),
      }))
      vi.stubGlobal('fetch', fetchMock)

      const { container } = render(ExtensionPanelPage, {
        props: {
          data: {
            ...baseData,
            html: '<p>x</p>',
            actionEndpoint: '/api/v1/extensions/panels/group/actions',
          },
        },
      })
      const iframe = container.querySelector('iframe') as HTMLIFrameElement
      dispatchPanelActionMessage(iframe)

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit]
      const headers = options.headers as Record<string, string>
      expect(headers['x-csrf-token']).toBe('cookie-csrf-value')
    })

    it('prefers the __Host- prefixed cookie name when both are present (production naming)', async () => {
      // jsdom (like a real browser) refuses to actually SET a `__Host-`-prefixed cookie from a
      // plain `http://localhost` origin (no Secure context) — this test stubs the `document.cookie`
      // getter directly instead, to exercise the preference-order logic independent of that
      // browser-enforced constraint (the constraint itself is exactly why tokens.ts only uses the
      // `__Host-` name when COOKIE_SECURE/HTTPS is actually on — see its own comment).
      const cookieGetter = vi
        .spyOn(document, 'cookie', 'get')
        .mockReturnValue('csrf-token=bare-value; __Host-csrf-token=host-prefixed-value')
      const fetchMock = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ message: 'ok' }),
      }))
      vi.stubGlobal('fetch', fetchMock)

      const { container } = render(ExtensionPanelPage, {
        props: {
          data: {
            ...baseData,
            html: '<p>x</p>',
            actionEndpoint: '/api/v1/extensions/panels/group/actions',
          },
        },
      })
      const iframe = container.querySelector('iframe') as HTMLIFrameElement
      dispatchPanelActionMessage(iframe)

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit]
      const headers = options.headers as Record<string, string>
      expect(headers['x-csrf-token']).toBe('host-prefixed-value')
      cookieGetter.mockRestore()
    })
  })
})
