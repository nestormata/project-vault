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

describe('/(app)/extensions/panels/[slot] +page.svelte (Story 25.1)', () => {
  function dispatchPanelDataRequest(iframe: HTMLIFrameElement, message: Record<string, unknown>) {
    window.dispatchEvent(
      new MessageEvent('message', { data: message, source: iframe.contentWindow as WindowProxy })
    )
  }

  it('is a real, existing route', () => {
    expect(routeExists('/extensions/panels/[slot]/[...subpath]')).toBe(true)
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

  describe('Story 25.12 AC2: the data relay validates against data.allowedDataPaths via structural segment matching', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('a request to a newly-declared path (beyond the legacy default) succeeds', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        status: 200,
        json: () => Promise.resolve({ data: { items: [] } }),
      })
      vi.stubGlobal('fetch', fetchMock)

      render(ExtensionPanelPage, {
        props: {
          data: {
            ...baseData,
            html: '<p>x</p>',
            allowedDataPaths: ['/api/v1/projects', '/api/v1/projects/:id', '/api/v1/org/users'],
          },
        },
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
        requestId: 'req-org-users',
        method: 'GET',
        path: '/api/v1/org/users',
      })

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/org/users',
        expect.objectContaining({ method: 'GET', credentials: 'same-origin' })
      )
      await vi.waitFor(() =>
        expect(posted).toContainEqual(
          expect.objectContaining({
            source: 'pv-extension-panel-data-result',
            requestId: 'req-org-users',
            ok: true,
          })
        )
      )
    })

    it('a request to an undeclared-but-/api/v1/-prefixed path is rejected with zero fetch calls', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      render(ExtensionPanelPage, {
        props: {
          data: {
            ...baseData,
            html: '<p>x</p>',
            allowedDataPaths: ['/api/v1/projects', '/api/v1/projects/:id', '/api/v1/org/users'],
          },
        },
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
        requestId: 'req-undeclared',
        method: 'POST',
        path: '/api/v1/admin/users',
      })

      await vi.waitFor(() =>
        expect(posted).toContainEqual(
          expect.objectContaining({
            source: 'pv-extension-panel-data-result',
            requestId: 'req-undeclared',
            ok: false,
          })
        )
      )
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('a request whose path matches a template segment count but has a literal mismatch is rejected', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      render(ExtensionPanelPage, {
        props: {
          data: {
            ...baseData,
            html: '<p>x</p>',
            allowedDataPaths: ['/api/v1/org/users'],
          },
        },
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
        requestId: 'req-literal-mismatch',
        method: 'GET',
        path: '/api/v1/org/groups',
      })

      await vi.waitFor(() =>
        expect(posted).toContainEqual(
          expect.objectContaining({
            source: 'pv-extension-panel-data-result',
            requestId: 'req-literal-mismatch',
            ok: false,
          })
        )
      )
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('a :param template segment matches any single non-empty, /-free path segment', async () => {
      const fetchMock = vi.fn().mockResolvedValue({
        status: 200,
        json: () => Promise.resolve({ data: {} }),
      })
      vi.stubGlobal('fetch', fetchMock)

      render(ExtensionPanelPage, {
        props: {
          data: {
            ...baseData,
            html: '<p>x</p>',
            allowedDataPaths: ['/api/v1/org/users/:id'],
          },
        },
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
        requestId: 'req-param',
        method: 'GET',
        path: '/api/v1/org/users/user_42',
      })

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/org/users/user_42',
        expect.objectContaining({ method: 'GET' })
      )
      await vi.waitFor(() =>
        expect(posted).toContainEqual(expect.objectContaining({ requestId: 'req-param', ok: true }))
      )
    })

    it('a mismatched segment count (extra trailing segment) is rejected', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      render(ExtensionPanelPage, {
        props: {
          data: {
            ...baseData,
            html: '<p>x</p>',
            allowedDataPaths: ['/api/v1/org/users'],
          },
        },
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
        requestId: 'req-extra-segment',
        method: 'GET',
        path: '/api/v1/org/users/extra',
      })

      await vi.waitFor(() =>
        expect(posted).toContainEqual(
          expect.objectContaining({ requestId: 'req-extra-segment', ok: false })
        )
      )
      expect(fetchMock).not.toHaveBeenCalled()
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

  describe('Story 25.12 AC1: the action relay forwards the full payload, not just kind', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('happy path: every field beyond source/requestId reaches the POST body verbatim', async () => {
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
      const event = new MessageEvent('message', {
        data: {
          source: 'pv-extension-panel-action',
          requestId: 'r1',
          kind: 'add-member',
          accessGroupId: 'g1',
          identityId: 'u2',
        },
      })
      Object.defineProperty(event, 'source', { value: iframe.contentWindow })
      window.dispatchEvent(event)

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(JSON.parse(options.body as string)).toEqual({
        kind: 'add-member',
        accessGroupId: 'g1',
        identityId: 'u2',
      })
    })

    it('a bare-kind message continues to send a byte-identical { kind } body (backward compat)', async () => {
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
      const event = new MessageEvent('message', {
        data: { source: 'pv-extension-panel-action', requestId: 'r1', kind: 'bare-action' },
      })
      Object.defineProperty(event, 'source', { value: iframe.contentWindow })
      window.dispatchEvent(event)

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(JSON.parse(options.body as string)).toEqual({ kind: 'bare-action' })
    })

    it('a __proto__-keyed field is spread as an own property, never pollutes Object.prototype', async () => {
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
      const maliciousData = JSON.parse(
        '{"source":"pv-extension-panel-action","requestId":"r1","kind":"create-group","name":"Ops","__proto__":{"polluted":true}}'
      ) as Record<string, unknown>
      const event = new MessageEvent('message', { data: maliciousData })
      Object.defineProperty(event, 'source', { value: iframe.contentWindow })
      window.dispatchEvent(event)

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
      const [, options] = fetchMock.mock.calls[0] as [string, RequestInit]
      const parsedBody = JSON.parse(options.body as string) as Record<string, unknown>
      // The relay's own prototype is unaffected — a spread-based destructure never reassigns
      // `action`'s prototype, even when the source message carries a field literally named
      // "__proto__": it becomes an ordinary own, enumerable property (visible in
      // Object.keys/JSON.stringify), never a prototype reassignment. `toEqual` can't express
      // this directly, since an object-literal `{ __proto__: ... }` sets a prototype rather than
      // an own property — asserted field-by-field instead.
      expect(Object.getPrototypeOf(parsedBody)).toBe(Object.prototype)
      expect(Object.keys(parsedBody).sort()).toEqual(['__proto__', 'kind', 'name'])
      expect(Object.prototype.hasOwnProperty.call(parsedBody, '__proto__')).toBe(true)
      expect(parsedBody['kind']).toBe('create-group')
      expect(parsedBody['name']).toBe('Ops')
      expect(parsedBody['__proto__']).toEqual({ polluted: true })
      // Deliberately asserting the AMBIENT Object.prototype is unaffected, not the parsed
      // object's own "__proto__" data property above.
      expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false)
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    })

    it('a message missing kind entirely still early-returns with no fetch (unchanged behavior)', async () => {
      const fetchMock = vi.fn()
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
      const event = new MessageEvent('message', {
        data: { source: 'pv-extension-panel-action', requestId: 'r1', accessGroupId: 'g1' },
      })
      Object.defineProperty(event, 'source', { value: iframe.contentWindow })
      window.dispatchEvent(event)

      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe('Story 25.8 AC3: navigation-request postMessage type', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('an allowed, authorized intent posts ok:true and navigates via goto()', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
      vi.stubGlobal('fetch', fetchMock)

      render(ExtensionPanelPage, {
        props: { data: { ...baseData, html: '<p>x</p>' } },
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
        source: 'pv-extension-panel-navigation-request',
        requestId: 'nav-1',
        kind: 'pv-project-detail',
        projectId: 'proj_123',
      })

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/projects/proj_123',
        expect.objectContaining({ method: 'GET', credentials: 'same-origin' })
      )
      await vi.waitFor(() =>
        expect(posted).toContainEqual(
          expect.objectContaining({
            source: 'pv-extension-panel-navigation-result',
            requestId: 'nav-1',
            ok: true,
          })
        )
      )
      await vi.waitFor(() => expect(gotoMock).toHaveBeenCalledWith('/projects/proj_123'))
    })

    it('a shape-invalid intent (unknown kind) is rejected without ever calling the authorization fetch or goto()', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      render(ExtensionPanelPage, {
        props: { data: { ...baseData, html: '<p>x</p>' } },
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
        source: 'pv-extension-panel-navigation-request',
        requestId: 'nav-2',
        kind: 'pv-attacker-controlled-destination',
        projectId: 'proj_123',
      })

      await vi.waitFor(() =>
        expect(posted).toContainEqual(
          expect.objectContaining({
            source: 'pv-extension-panel-navigation-result',
            requestId: 'nav-2',
            ok: false,
          })
        )
      )
      expect(fetchMock).not.toHaveBeenCalled()
      expect(gotoMock).not.toHaveBeenCalled()
    })

    it('Security Audit Personas (Elicitation Log #1): a shape-valid but cross-org/unauthorized projectId is rejected, never navigated to', async () => {
      // The real authorization check — GET /api/v1/projects/:projectId — 404s for a project this
      // session cannot see (org visibility gate), same non-leaking-existence shape as a genuinely
      // nonexistent project. A shape-valid `kind`/`projectId` alone must NOT be sufficient.
      const fetchMock = vi
        .fn()
        .mockResolvedValue({ ok: false, status: 404, json: async () => ({}) })
      vi.stubGlobal('fetch', fetchMock)

      render(ExtensionPanelPage, {
        props: { data: { ...baseData, html: '<p>x</p>' } },
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
        source: 'pv-extension-panel-navigation-request',
        requestId: 'nav-3',
        kind: 'pv-project-detail',
        projectId: 'proj_not_mine',
      })

      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
      await vi.waitFor(() =>
        expect(posted).toContainEqual(
          expect.objectContaining({
            source: 'pv-extension-panel-navigation-result',
            requestId: 'nav-3',
            ok: false,
          })
        )
      )
      expect(gotoMock).not.toHaveBeenCalled()
    })
  })

  describe('Story 25.8 Task 2a: in-flight requests are invalidated when a navigation swaps srcdoc', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('a data-request still in flight when the panel navigates never has its response posted', async () => {
      let resolveFetch: (value: { status: number; json: () => Promise<unknown> }) => void = () => {}
      const fetchMock = vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve
          })
      )
      vi.stubGlobal('fetch', fetchMock)

      const { rerender } = render(ExtensionPanelPage, {
        props: { data: { ...baseData, slot: 'group', html: '<p>a</p>' } },
      })
      const iframe = document.querySelector('iframe') as HTMLIFrameElement
      const posted: unknown[] = []
      const contentWindow = iframe.contentWindow as unknown as {
        postMessage: typeof window.postMessage
      }
      vi.spyOn(contentWindow, 'postMessage').mockImplementation((data: unknown) => {
        posted.push(data)
      })

      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            source: 'pv-extension-panel-data-request',
            requestId: 'stale-req',
            method: 'GET',
            path: '/api/v1/projects',
          },
          source: iframe.contentWindow as WindowProxy,
        })
      )
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())

      // A navigation swaps the composed srcdoc (different html) BEFORE the in-flight fetch above
      // resolves — this is the exact race the Boundary & Edge Case Sweep finding (Elicitation
      // Log #3) describes.
      await rerender({ data: { ...baseData, slot: 'group', html: '<p>b</p>' } })

      // Now let the stale fetch resolve.
      resolveFetch({ status: 200, json: () => Promise.resolve({ data: {} }) })
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(posted).not.toContainEqual(expect.objectContaining({ requestId: 'stale-req' }))
    })
  })

  describe('Story 25.8 AC2: back/forward across panel sub-states', () => {
    it('drives two sequential sub-state navigations plus a back-navigation, restoring correct content each time with no error', async () => {
      const { rerender } = render(ExtensionPanelPage, {
        props: { data: { ...baseData, html: '<p>state-a</p>' } },
      })
      expect(document.querySelector('iframe')?.getAttribute('srcdoc')).toContain('state-a')

      // First forward sub-state navigation.
      await rerender({ data: { ...baseData, html: '<p>state-b</p>' } })
      expect(document.querySelector('iframe')?.getAttribute('srcdoc')).toContain('state-b')
      expect(document.querySelector('iframe')?.getAttribute('srcdoc')).not.toContain('state-a')

      // Second forward sub-state navigation.
      await rerender({ data: { ...baseData, html: '<p>state-c</p>' } })
      expect(document.querySelector('iframe')?.getAttribute('srcdoc')).toContain('state-c')

      // Browser back-navigation returns to the FIRST sub-state (SvelteKit resyncs `data` via its
      // own afterNavigate/load cycle on a popstate; this simulates the resulting prop update).
      await rerender({ data: { ...baseData, html: '<p>state-a</p>' } })
      expect(document.querySelector('iframe')?.getAttribute('srcdoc')).toContain('state-a')
      expect(document.querySelector('iframe')?.getAttribute('srcdoc')).not.toContain('state-c')

      // No stuck stale iframe, no missing iframe, no thrown error anywhere above.
      expect(document.querySelectorAll('iframe')).toHaveLength(1)
    })

    it('a back-navigation to the degraded (html: null) state removes the iframe cleanly, no stale content left behind', async () => {
      const { rerender } = render(ExtensionPanelPage, {
        props: { data: { ...baseData, html: '<p>state-a</p>' } },
      })
      expect(document.querySelector('iframe')).toBeTruthy()

      await rerender({ data: { ...baseData, html: null } })

      expect(document.querySelector('iframe')).toBeNull()
      expect(screen.getByText(/temporarily unavailable/i)).toBeTruthy()
    })
  })
})
