import { afterEach, describe, expect, it, vi } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { cleanup, render, screen } from '@testing-library/svelte'
import { routeExists } from '$lib/test/route-exists.js'
import { BASE_EXTENSION_THEME_VARS } from '$lib/security/extension-theme-vars.js'

// Story 61.1 E1 — must return a promise: client.ts's redirectToSessionExpired() chains
// `.then(reset, reset)` onto goto()'s result.
const gotoMock = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('$app/navigation', () => ({ goto: gotoMock }))

import ExtensionPanelPage from './+page.svelte'

afterEach(() => {
  cleanup()
  gotoMock.mockReset()
})

const baseData = {
  slot: 'group',
  html: null as string | null,
  themeVars: BASE_EXTENSION_THEME_VARS,
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

  // Story 29.4 AC7/AC10 — the DATA relay (`PANEL_DATA_REQUEST_SOURCE`/`handlePanelDataMessage`
  // and friends) is now DELETED outright from this component's source, not merely inert — this
  // is a regression test proving a DATA-request-shaped `postMessage` (the exact shape the old
  // relay used to handle) is simply unhandled now: `handlePanelMessage`'s single remaining branch
  // dispatches only to `handlePanelNavigationMessage`, so no code path exists any more that could
  // ever call `fetch()` in response to this message shape.
  describe('Story 29.4 AC7: the DATA relay is provably removed (no code path handles it any more)', () => {
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
  })

  // Story 29.6 AC2/AC3/AC11 — the NAVIGATION postMessage relay (and the entire postMessage
  // listener infrastructure it was the last live branch of — `handlePanelMessage`, `panelIframe`,
  // `pendingRequestIds`) is DELETED outright, not merely left inert a fourth time (matching Story
  // 29.2's ACTION-relay and Story 29.4's DATA-relay own "provably removed" precedent — see those
  // stories' own AC12/AC7). The old `describe('Story 29.1 AC8: ... is inert ...')` block that
  // lived here asserted only that the *handler* couldn't fire (an identity check on a
  // `panelIframe` that could never exist) — it is replaced below with a stronger proof: no
  // `window` `'message'` listener capable of reacting to this shape exists AT ALL any more, by
  // construction of this story's deletion, not merely by an identity-check that always fails.
  describe('Story 29.6 AC2/AC3/AC11: the NAVIGATION postMessage relay and its listener infrastructure are provably removed', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('mounting the page never registers a window "message" event listener at all', () => {
      const addEventListenerSpy = vi.spyOn(window, 'addEventListener')

      render(ExtensionPanelPage, {
        props: { data: { ...baseData, html: '<p>x</p>' } },
      })

      const messageListenerCalls = addEventListenerSpy.mock.calls.filter(
        ([eventName]) => eventName === 'message'
      )
      expect(messageListenerCalls).toHaveLength(0)

      addEventListenerSpy.mockRestore()
    })

    it('a navigation-request-shaped message never triggers a fetch or goto() — there is no listener left to react to it', async () => {
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

  // Story 29.6 AC1/AC11 — a panel now triggers navigation via an ordinary `<a href>` rendered
  // directly in its own HTML, sanitized and injected exactly like any other panel content
  // (Story 29.1's `renderPanelHtml` pipeline) — no postMessage, no host-side intent negotiation.
  describe('Story 29.6 AC1/AC8/AC11: a panel-rendered <a href> survives sanitization intact', () => {
    it('AC1: a PV-native project-detail link renders with its href attribute intact in the live sanitized DOM', () => {
      render(ExtensionPanelPage, {
        props: {
          data: { ...baseData, html: '<a href="/projects/proj_abc123">View project</a>' },
        },
      })

      const link = screen.getByRole('link', { name: 'View project' })
      expect(link.getAttribute('href')).toBe('/projects/proj_abc123')
    })

    it('AC1: a same-route panel-subpath navigation link renders with its href attribute intact', () => {
      render(ExtensionPanelPage, {
        props: {
          data: {
            ...baseData,
            html: '<a href="/extensions/panels/group/detail/proj_abc123">Open detail</a>',
          },
        },
      })

      const link = screen.getByRole('link', { name: 'Open detail' })
      expect(link.getAttribute('href')).toBe('/extensions/panels/group/detail/proj_abc123')
    })

    it('AC9: a javascript:-scheme href is stripped by DOMPurify — the surviving anchor carries no href attribute', () => {
      render(ExtensionPanelPage, {
        props: {
          data: { ...baseData, html: '<a href="javascript:alert(1)">bad</a>' },
        },
      })

      const link = screen.getByText('bad')
      expect(link.tagName).toBe('A')
      expect(link.getAttribute('href')).toBeNull()
    })
  })

  // Story 29.2 — the real replacement for the retired postMessage ACTION relay: a single
  // delegated click handler on the panel container, resolving `[data-pv-action]` elements and
  // issuing a direct same-origin fetch. AC2/AC3/AC5/AC6/AC7/AC8/AC9.
  describe('Story 29.2: click-delegation action dispatch', () => {
    afterEach(() => vi.unstubAllGlobals())

    const actionHtml =
      '<button type="button" data-pv-action="test-action" data-pv-action-note="hi"><span>Run</span></button>'
    const actionData = {
      ...baseData,
      html: actionHtml,
      actionEndpoint: '/api/v1/extensions/panels/group/actions',
    }

    function jsonResponse(
      status: number,
      body: unknown
    ): {
      ok: boolean
      status: number
      json: () => Promise<unknown>
      clone: () => unknown
    } {
      return {
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
        // Story 61.1 — fetchWithSessionRefresh() peeks at a 401's code via response.clone().
        clone: () => jsonResponse(status, body),
      }
    }

    function flush() {
      return new Promise((resolve) => setTimeout(resolve, 0))
    }

    it('AC2: a click on a nested element (icon/text inside the action element) still resolves via closest()', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { message: 'done' }))
      vi.stubGlobal('fetch', fetchMock)
      render(ExtensionPanelPage, { props: { data: actionData } })

      screen.getByText('Run').click()
      await flush()

      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('AC3: no data-pv-action element clicked, or no actionEndpoint declared, is a silent no-op', async () => {
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)
      const { rerender } = render(ExtensionPanelPage, {
        props: { data: { ...baseData, html: '<p>no actions here</p>' } },
      })
      panelContainer()?.click()
      await flush()
      expect(fetchMock).not.toHaveBeenCalled()

      // data-pv-action present, but no actionEndpoint declared (no moduleActions) — still a no-op.
      await rerender({ data: { ...baseData, html: actionHtml } })
      screen.getByText('Run').click()
      await flush()
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('AC3: the request body is built from kind + every data-pv-action-<field> attribute via a safe accumulation pattern', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { message: 'done' }))
      vi.stubGlobal('fetch', fetchMock)
      render(ExtensionPanelPage, { props: { data: actionData } })

      screen.getByText('Run').click()
      await flush()

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/v1/extensions/panels/group/actions',
        expect.objectContaining({
          method: 'POST',
          credentials: 'same-origin',
          body: JSON.stringify({ kind: 'test-action', note: 'hi' }),
        })
      )
    })

    it('AC3: a panel-declared data-pv-action-__proto__ field cannot pollute the request body object prototype', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { message: 'done' }))
      vi.stubGlobal('fetch', fetchMock)
      render(ExtensionPanelPage, {
        props: {
          data: {
            ...actionData,
            html: '<button type="button" data-pv-action="test-action" data-pv-action-__proto__="hi">Run</button>',
          },
        },
      })

      screen.getByText('Run').click()
      await flush()

      const sentBody = JSON.parse(
        (fetchMock.mock.calls[0]?.[1] as { body: string }).body
      ) as Record<string, unknown>
      expect(Object.getPrototypeOf(sentBody)).toBe(Object.prototype)
      expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    })

    it('AC5: a 2xx html result re-renders the container through the same sanitize pipeline, replacing prior content', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse(200, { html: '<p>updated by action</p>' }))
      vi.stubGlobal('fetch', fetchMock)
      render(ExtensionPanelPage, { props: { data: actionData } })

      screen.getByText('Run').click()
      await flush()

      const container = panelContainer()
      expect(container?.innerHTML).toContain('updated by action')
      expect(container?.querySelector('[data-pv-action]')).toBeNull()
    })

    it('AC6: a message-only 2xx result renders in a host-owned status region outside the panel container, container untouched', async () => {
      const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { message: 'Action done' }))
      vi.stubGlobal('fetch', fetchMock)
      render(ExtensionPanelPage, { props: { data: actionData } })

      screen.getByText('Run').click()
      await flush()

      const status = screen.getByText('Action done')
      expect(status.getAttribute('aria-live')).toBe('polite')
      expect(panelContainer()?.contains(status)).toBe(false)
      expect(panelContainer()?.querySelector('[data-pv-action]')).not.toBeNull()
    })

    it.each([
      ['validation_failed', 400, 'validation_failed', 'That input was invalid', true],
      ['conflict', 409, 'conflict', 'Already in progress', true],
      ['denied', 403, 'denied', 'Request denied', false],
      ['a generic non-2xx outcome', 500, 'internal_error', 'Request failed', false],
    ] as const)(
      'AC7: %s renders in the AC6 status region (server message shown verbatim: %s)',
      async (_label, status, code, serverMessage, showsServerMessageVerbatim) => {
        const fetchMock = vi
          .fn()
          .mockResolvedValue(jsonResponse(status, { code, message: serverMessage }))
        vi.stubGlobal('fetch', fetchMock)
        render(ExtensionPanelPage, { props: { data: actionData } })

        screen.getByText('Run').click()
        await flush()

        if (showsServerMessageVerbatim) {
          expect(screen.getByText(serverMessage)).toBeTruthy()
        } else {
          expect(screen.queryByText(serverMessage)).toBeNull()
        }
      }
    )

    it('AC7: a network-level fetch rejection renders a fixed, non-leaking message in the status region', async () => {
      const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
      vi.stubGlobal('fetch', fetchMock)
      render(ExtensionPanelPage, { props: { data: actionData } })

      screen.getByText('Run').click()
      await flush()

      expect(screen.queryByText(/Failed to fetch/)).toBeNull()
      const container = document.querySelector('[aria-live="polite"]')
      expect(container?.textContent).toBeTruthy()
    })

    it('AC8: a rapid repeat click before the first request settles does not issue a second concurrent request; the element is disabled/aria-busy while in flight and re-enabled once it settles', async () => {
      let resolveFetch: (value: unknown) => void = () => undefined
      const fetchMock = vi.fn().mockReturnValue(
        new Promise((resolve) => {
          resolveFetch = resolve
        })
      )
      vi.stubGlobal('fetch', fetchMock)
      render(ExtensionPanelPage, { props: { data: actionData } })

      const button = screen.getByText('Run').closest('button') as HTMLButtonElement
      button.click()
      button.click()
      button.click()
      await flush()

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(button.disabled).toBe(true)
      expect(button.getAttribute('aria-busy')).toBe('true')

      resolveFetch(jsonResponse(200, { message: 'done' }))
      await flush()

      expect(button.disabled).toBe(false)
      expect(button.getAttribute('aria-busy')).toBeNull()
    })

    it('AC9: a stale in-flight response is dropped when data.html changes (navigation) before it resolves', async () => {
      let resolveFetch: (value: unknown) => void = () => undefined
      const fetchMock = vi.fn().mockReturnValue(
        new Promise((resolve) => {
          resolveFetch = resolve
        })
      )
      vi.stubGlobal('fetch', fetchMock)
      const { rerender } = render(ExtensionPanelPage, { props: { data: actionData } })

      screen.getByText('Run').click()
      await flush()
      expect(fetchMock).toHaveBeenCalledTimes(1)

      await rerender({
        data: { ...actionData, slot: 'other-slot', html: '<p>navigated away</p>' },
      })

      resolveFetch(jsonResponse(200, { message: 'stale message, must be dropped' }))
      await flush()

      expect(screen.queryByText('stale message, must be dropped')).toBeNull()
      expect(panelContainer()?.innerHTML).toContain('navigated away')
    })

    // Story 30.3 — DW-141 non-security edge-case hardening for handleActionClick.
    describe('Story 30.3: action-dispatch edge-case hardening', () => {
      it('AC1 (Story 30.3): a data-pv-action-kind attribute cannot override the real action kind', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { message: 'done' }))
        vi.stubGlobal('fetch', fetchMock)
        render(ExtensionPanelPage, {
          props: {
            data: {
              ...actionData,
              html: '<button type="button" data-pv-action="test-action" data-pv-action-kind="attacker-controlled-kind">Run</button>',
            },
          },
        })

        screen.getByText('Run').click()
        await flush()

        expect(fetchMock).toHaveBeenCalledWith(
          '/api/v1/extensions/panels/group/actions',
          expect.objectContaining({ body: JSON.stringify({ kind: 'test-action' }) })
        )
      })

      it('AC1 (Story 30.3, regression): kind + data-pv-action-note still round-trips unaffected', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { message: 'done' }))
        vi.stubGlobal('fetch', fetchMock)
        render(ExtensionPanelPage, { props: { data: actionData } })

        screen.getByText('Run').click()
        await flush()

        expect(fetchMock).toHaveBeenCalledWith(
          '/api/v1/extensions/panels/group/actions',
          expect.objectContaining({ body: JSON.stringify({ kind: 'test-action', note: 'hi' }) })
        )
      })

      it('AC2 (Story 30.3): preventDefault() is called for an accepted click, suppressing native navigation/form-submit', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { message: 'done' }))
        vi.stubGlobal('fetch', fetchMock)
        render(ExtensionPanelPage, {
          props: {
            data: {
              ...actionData,
              html: '<a href="/some/other/route" data-pv-action="test-action">Run</a>',
            },
          },
        })

        const link = screen.getByText('Run').closest('a') as HTMLAnchorElement
        const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true })
        const preventDefaultSpy = vi.spyOn(clickEvent, 'preventDefault')
        link.dispatchEvent(clickEvent)
        await flush()

        expect(preventDefaultSpy).toHaveBeenCalledTimes(1)
        expect(fetchMock).toHaveBeenCalledTimes(1)
      })

      it('AC2 (Story 30.3): preventDefault() is NOT called for a no-op click (no matching data-pv-action element)', () => {
        const fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)
        render(ExtensionPanelPage, {
          props: { data: { ...baseData, html: '<p>no actions here</p>' } },
        })

        const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true })
        const preventDefaultSpy = vi.spyOn(clickEvent, 'preventDefault')
        panelContainer()?.dispatchEvent(clickEvent)

        expect(preventDefaultSpy).not.toHaveBeenCalled()
        expect(fetchMock).not.toHaveBeenCalled()
      })

      it('AC2 (Story 30.3): preventDefault() is NOT called for a data-pv-action element with no actionEndpoint declared', () => {
        const fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)
        render(ExtensionPanelPage, { props: { data: { ...baseData, html: actionHtml } } })

        const button = screen.getByText('Run').closest('button') as HTMLButtonElement
        const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true })
        const preventDefaultSpy = vi.spyOn(clickEvent, 'preventDefault')
        button.dispatchEvent(clickEvent)

        expect(preventDefaultSpy).not.toHaveBeenCalled()
        expect(fetchMock).not.toHaveBeenCalled()
      })

      it('AC3 (Story 30.3): a slower-resolving click on one element does not clobber a faster click already applied on another element', async () => {
        let resolveFirst: (value: unknown) => void = () => undefined
        let resolveSecond: (value: unknown) => void = () => undefined
        const fetchMock = vi
          .fn()
          .mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
          .mockReturnValueOnce(new Promise((resolve) => (resolveSecond = resolve)))
        vi.stubGlobal('fetch', fetchMock)
        render(ExtensionPanelPage, {
          props: {
            data: {
              ...actionData,
              html:
                '<button type="button" data-pv-action="first-action">First</button>' +
                '<button type="button" data-pv-action="second-action">Second</button>',
            },
          },
        })

        const firstButton = screen.getByText('First')
        firstButton.click()
        await flush()
        screen.getByText('Second').click()
        await flush()

        expect(fetchMock).toHaveBeenCalledTimes(2)
        // AC8 — both elements are marked in-flight independently; the first click's own guard
        // never blocked the second click on a different element.
        expect(firstButton.hasAttribute('disabled')).toBe(true)

        // Faster (second) click resolves first, applying its result.
        resolveSecond(jsonResponse(200, { message: 'second result' }))
        await flush()
        expect(screen.getByText('second result')).toBeTruthy()

        // Slower (first) click's response arrives after — must be dropped, not overwrite the
        // second click's already-applied result.
        resolveFirst(jsonResponse(200, { message: 'first result, must be dropped' }))
        await flush()
        expect(screen.queryByText('first result, must be dropped')).toBeNull()
        expect(screen.getByText('second result')).toBeTruthy()

        // Code-review hardening (2026-08-30) — dropping the stale (first) click's *result* must
        // not also permanently strand its own button in a disabled/aria-busy state: it settled,
        // its response was superseded but real, and there is no other trigger left that will ever
        // re-enable it.
        expect(firstButton.hasAttribute('disabled')).toBe(false)
        expect(firstButton.hasAttribute('aria-busy')).toBe(false)
      })
    })

    // Story 59.1 AC6 — extension html on a non-2xx action response is rendered through the same
    // single sanitize-and-inject path as 2xx html; the status region keeps today's announcement.
    describe('Story 59.1: non-2xx action html', () => {
      const GENERIC = 'Unable to complete this action. Please try again.'

      function statusRegion(): Element | null {
        return document.querySelector('[aria-live="polite"]')
      }

      it.each([
        [
          403,
          { code: 'denied', message: 'Request denied' },
          '<p>You no longer have access to this share.</p>',
          'You no longer have access to this share.',
          GENERIC,
        ],
        [
          409,
          { code: 'conflict', message: 'Already renamed' },
          '<p>Conflict banner</p>',
          'Conflict banner',
          'Already renamed',
        ],
        [
          500,
          { code: 'internal_error', message: 'Request failed' },
          '<p>Temporarily unavailable</p>',
          'Temporarily unavailable',
          GENERIC,
        ],
      ] as const)(
        '%i with html replaces the container and keeps the status announcement',
        async (status, body, html, expectedContent, expectedStatus) => {
          vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(status, { ...body, html })))
          render(ExtensionPanelPage, { props: { data: actionData } })

          screen.getByText('Run').click()
          await flush()

          const container = panelContainer()
          expect(container?.innerHTML).toContain(expectedContent)
          expect(container?.querySelector('[data-pv-action]')).toBeNull()
          expect(statusRegion()?.textContent).toContain(expectedStatus)
          expect(container?.contains(statusRegion())).toBe(false)
          if (status === 403) expect(statusRegion()?.textContent).not.toContain('Request denied')
        }
      )

      it('failure html is sanitized exactly like success html (no script, handler, style, link or iframe)', async () => {
        const hostile =
          '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>' +
          '<style>body{display:none}</style><link rel="stylesheet" href="https://evil.example/x.css">' +
          '<iframe src="https://evil.example"></iframe><p>ok</p>'
        vi.stubGlobal(
          'fetch',
          vi.fn().mockResolvedValue(jsonResponse(403, { code: 'denied', html: hostile }))
        )
        render(ExtensionPanelPage, { props: { data: actionData } })

        screen.getByText('Run').click()
        await flush()

        const container = panelContainer()
        expect(container?.innerHTML).toContain('<p>ok</p>')
        expect(container?.querySelector('script, style, link, iframe')).toBeNull()
        expect(container?.innerHTML).not.toContain('onerror')
        expect((window as unknown as { __pwned?: unknown }).__pwned).toBeUndefined()
      })

      it.each([
        ['an empty string', { html: '' }],
        ['no html key', {}],
        ['a non-string', { html: 42 }],
      ])('%s html leaves the container untouched', async (_label, extra) => {
        vi.stubGlobal(
          'fetch',
          vi
            .fn()
            .mockResolvedValue(
              jsonResponse(403, { code: 'denied', message: 'Request denied', ...extra })
            )
        )
        render(ExtensionPanelPage, { props: { data: actionData } })

        const button = screen.getByText('Run').closest('button') as HTMLButtonElement
        button.click()
        await flush()

        expect(panelContainer()?.querySelector('[data-pv-action]')).not.toBeNull()
        expect(statusRegion()?.textContent).toContain(GENERIC)
        expect(button.disabled).toBe(false)
      })

      it.each([403, 200])(
        'a %i-with-html response whose body is still being read when navigation happens is dropped',
        async (status) => {
          let resolveBody: (value: unknown) => void = () => undefined
          vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
              ok: status >= 200 && status < 300,
              status,
              json: () => new Promise((resolve) => (resolveBody = resolve)),
            })
          )
          const { rerender } = render(ExtensionPanelPage, { props: { data: actionData } })

          const button = screen.getByText('Run').closest('button') as HTMLButtonElement
          button.click()
          await flush()
          // Headers have arrived (fetch resolved); the body is still streaming when the user
          // navigates to another slot.
          await rerender({
            data: { ...actionData, slot: 'other-slot', html: '<p>navigated away</p>' },
          })

          resolveBody({ code: 'denied', message: 'Request denied', html: '<p>stale banner</p>' })
          await flush()

          expect(panelContainer()?.innerHTML).toContain('navigated away')
          expect(panelContainer()?.innerHTML).not.toContain('stale banner')
          expect(statusRegion()?.textContent ?? '').not.toContain(GENERIC)
          expect(button.hasAttribute('disabled')).toBe(false)
        }
      )

      it('a stale 403-with-html response after navigation is dropped, and the element is re-enabled', async () => {
        let resolveFetch: (value: unknown) => void = () => undefined
        vi.stubGlobal(
          'fetch',
          vi.fn().mockReturnValue(new Promise((resolve) => (resolveFetch = resolve)))
        )
        const { rerender } = render(ExtensionPanelPage, { props: { data: actionData } })

        const button = screen.getByText('Run').closest('button') as HTMLButtonElement
        button.click()
        await flush()
        await rerender({
          data: { ...actionData, slot: 'other-slot', html: '<p>navigated away</p>' },
        })

        resolveFetch(jsonResponse(403, { code: 'denied', html: '<p>stale banner</p>' }))
        await flush()

        expect(panelContainer()?.innerHTML).toContain('navigated away')
        expect(panelContainer()?.innerHTML).not.toContain('stale banner')
        expect(button.hasAttribute('disabled')).toBe(false)
      })

      it('a stale 403-with-html response superseded by a later click is dropped, and its element is re-enabled', async () => {
        let resolveFirst: (value: unknown) => void = () => undefined
        let resolveSecond: (value: unknown) => void = () => undefined
        vi.stubGlobal(
          'fetch',
          vi
            .fn()
            .mockReturnValueOnce(new Promise((resolve) => (resolveFirst = resolve)))
            .mockReturnValueOnce(new Promise((resolve) => (resolveSecond = resolve)))
        )
        render(ExtensionPanelPage, {
          props: {
            data: {
              ...actionData,
              html:
                '<button type="button" data-pv-action="first-action">First</button>' +
                '<button type="button" data-pv-action="second-action">Second</button>',
            },
          },
        })

        const firstButton = screen.getByText('First')
        firstButton.click()
        await flush()
        screen.getByText('Second').click()
        await flush()

        resolveSecond(jsonResponse(200, { message: 'second result' }))
        await flush()
        resolveFirst(jsonResponse(403, { code: 'denied', html: '<p>stale banner</p>' }))
        await flush()

        expect(panelContainer()?.innerHTML).not.toContain('stale banner')
        expect(screen.getByText('second result')).toBeTruthy()
        expect(firstButton.hasAttribute('disabled')).toBe(false)
        expect(firstButton.hasAttribute('aria-busy')).toBe(false)
      })

      const RETRY_BANNER =
        '<p>Share revoked</p><button type="button" data-pv-action="retry">Retry</button>'

      it.each([
        [403, { code: 'denied', message: 'Request denied' }, GENERIC],
        [200, {}, undefined],
      ] as const)(
        'identical html on two consecutive %i responses re-enables the second clicked element',
        async (status, body, expectedStatus) => {
          vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(jsonResponse(status, { ...body, html: RETRY_BANNER }))
          )
          render(ExtensionPanelPage, { props: { data: actionData } })

          screen.getByText('Run').click()
          await flush()
          const retry = screen.getByText('Retry').closest('button') as HTMLButtonElement
          retry.click()
          await flush()

          expect(screen.getByText('Retry')).toBe(retry)
          expect(retry.disabled).toBe(false)
          expect(retry.hasAttribute('aria-busy')).toBe(false)
          if (expectedStatus !== undefined) {
            expect(statusRegion()?.textContent).toContain(expectedStatus)
          }
        }
      )

      it('a non-JSON 500 from an intermediary leaves the container untouched with the generic message', async () => {
        vi.stubGlobal(
          'fetch',
          vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            json: () => Promise.reject(new SyntaxError('Unexpected token <')),
          })
        )
        render(ExtensionPanelPage, { props: { data: actionData } })

        screen.getByText('Run').click()
        await flush()

        expect(panelContainer()?.querySelector('[data-pv-action]')).not.toBeNull()
        expect(statusRegion()?.textContent).toContain(GENERIC)
      })

      it.each([
        [429, { code: 'rate_limited', message: 'Too many requests' }],
        [404, { code: 'action_not_found', message: 'Action not found' }],
      ] as const)('a host-generated %i without html behaves as before', async (status, body) => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(status, body)))
        render(ExtensionPanelPage, { props: { data: actionData } })

        screen.getByText('Run').click()
        await flush()

        expect(panelContainer()?.querySelector('[data-pv-action]')).not.toBeNull()
        expect(statusRegion()?.textContent).toContain(GENERIC)
        expect(statusRegion()?.textContent).not.toContain(body.message)
      })
    })

    // Story 61.1 — the action dispatcher refreshes the session on a refreshable 401 and retries
    // exactly once (AC1), follows the standard session-expired path when the refresh fails (AC2),
    // and keeps the panelGeneration paint gate across the retry (AC3).
    describe('Story 61.1: refresh-on-401', () => {
      const REFRESH_URL = '/api/v1/auth/refresh'
      const ACTION_URL = '/api/v1/extensions/panels/group/actions'
      const GENERIC = 'Unable to complete this action. Please try again.'
      const TWO_BUTTONS =
        '<button type="button" data-pv-action="a-action">A</button>' +
        '<button type="button" data-pv-action="b-action">B</button>'

      afterEach(() => {
        document.cookie = 'csrf-token=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'
      })

      function expired(code = 'access_token_missing') {
        return jsonResponse(401, { code, message: 'Access token is missing' })
      }

      function refreshOk() {
        return jsonResponse(200, { data: { expiresAt: '2026-09-26T02:00:00.000Z' } })
      }

      /** Routes `/auth/refresh` to `refresh()` and every other call to the next queued action
       * response, in call order (a queued entry may be a pending promise). */
      function routedFetch(actionResponses: unknown[], refresh: () => unknown = refreshOk) {
        const queue = [...actionResponses]
        return vi.fn(async (url: string, _init?: RequestInit) =>
          url === REFRESH_URL ? refresh() : queue.shift()
        )
      }

      function deferred<T = unknown>() {
        let resolve: (value: T) => void = () => undefined
        const promise = new Promise<T>((r) => (resolve = r))
        return { promise, resolve }
      }

      function callsTo(fetchMock: ReturnType<typeof routedFetch>, url: string) {
        return fetchMock.mock.calls.filter(([calledUrl]) => calledUrl === url)
      }

      function statusRegion(): Element | null {
        return document.querySelector('[aria-live="polite"]')
      }

      function csrfHeaderOf(fetchMock: ReturnType<typeof routedFetch>, callIndex: number) {
        const init = fetchMock.mock.calls.at(callIndex)?.[1] as { headers: Record<string, string> }
        return init.headers['x-csrf-token']
      }

      // E2 — client.ts's redirect latch is module-level state; let it reset before the next test.
      async function settleRedirectLatch() {
        await vi.waitFor(() => expect(gotoMock).toHaveBeenCalled())
        await flush()
      }

      it('AC1: 401 -> refresh -> retry paints the retried html (exactly 3 calls, same URL/method/body)', async () => {
        const fetchMock = routedFetch([expired(), jsonResponse(200, { html: '<p>done</p>' })])
        vi.stubGlobal('fetch', fetchMock)
        render(ExtensionPanelPage, { props: { data: actionData } })

        screen.getByText('Run').click()
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
        await flush()

        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
          ACTION_URL,
          REFRESH_URL,
          ACTION_URL,
        ])
        const [first, , retry] = fetchMock.mock.calls
        expect(retry?.[1]).toMatchObject({
          method: 'POST',
          credentials: 'same-origin',
          body: JSON.stringify({ kind: 'test-action', note: 'hi' }),
        })
        expect(retry?.[1]?.body).toBe(first?.[1]?.body)
        expect(panelContainer()?.innerHTML).toContain('done')
        expect(statusRegion()?.textContent?.trim() ?? '').toBe('')
        expect(gotoMock).not.toHaveBeenCalled()
      })

      it.each(['access_token_invalid', 'session_revoked'])(
        'AC1: a %s 401 is refreshed and a message-only retry shows its message, element re-enabled',
        async (code) => {
          const fetchMock = routedFetch([expired(code), jsonResponse(200, { message: 'Saved' })])
          vi.stubGlobal('fetch', fetchMock)
          render(ExtensionPanelPage, { props: { data: actionData } })

          const button = screen.getByText('Run').closest('button') as HTMLButtonElement
          button.click()
          await vi.waitFor(() => expect(screen.getByText('Saved')).toBeTruthy())

          expect(callsTo(fetchMock, REFRESH_URL)).toHaveLength(1)
          expect(button.disabled).toBe(false)
          expect(button.hasAttribute('aria-busy')).toBe(false)
        }
      )

      it('AC1: the retry re-reads the CSRF cookie rotated by the refresh', async () => {
        document.cookie = 'csrf-token=old; path=/'
        const fetchMock = routedFetch([expired(), jsonResponse(200, { message: 'Saved' })], () => {
          document.cookie = 'csrf-token=new; path=/'
          return refreshOk()
        })
        vi.stubGlobal('fetch', fetchMock)
        render(ExtensionPanelPage, { props: { data: actionData } })

        screen.getByText('Run').click()
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))

        expect(csrfHeaderOf(fetchMock, 0)).toBe('old')
        expect(csrfHeaderOf(fetchMock, 2)).toBe('new')
      })

      it('AC1: no CSRF cookie before the click, one set by the refresh -> only the retry carries it', async () => {
        const fetchMock = routedFetch([expired(), jsonResponse(200, { message: 'Saved' })], () => {
          document.cookie = 'csrf-token=fresh; path=/'
          return refreshOk()
        })
        vi.stubGlobal('fetch', fetchMock)
        render(ExtensionPanelPage, { props: { data: actionData } })

        screen.getByText('Run').click()
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))

        expect(csrfHeaderOf(fetchMock, 0)).toBeUndefined()
        expect(csrfHeaderOf(fetchMock, 2)).toBe('fresh')
      })

      it('AC1: a retried 409 with html renders the banner and the verbatim conflict message (59.1)', async () => {
        const fetchMock = routedFetch([
          expired(),
          jsonResponse(409, { code: 'conflict', message: 'Stale', html: '<p>banner</p>' }),
        ])
        vi.stubGlobal('fetch', fetchMock)
        render(ExtensionPanelPage, { props: { data: actionData } })

        screen.getByText('Run').click()
        await vi.waitFor(() => expect(panelContainer()?.innerHTML).toContain('banner'))

        expect(statusRegion()?.textContent).toContain('Stale')
      })

      it.each([
        ['401 mfa_step_up_required', () => jsonResponse(401, { code: 'mfa_step_up_required' })],
        ['401 with an unknown code', () => jsonResponse(401, { code: 'something_else' })],
        [
          'a non-JSON 401',
          () => ({
            ok: false,
            status: 401,
            json: () => Promise.reject(new SyntaxError('Unexpected token <')),
            clone: () => ({ json: () => Promise.reject(new SyntaxError('Unexpected token <')) }),
          }),
        ],
        ['403 csrf_rejected', () => jsonResponse(403, { code: 'csrf_rejected' })],
        ['429', () => jsonResponse(429, { code: 'rate_limited' })],
        ['500', () => jsonResponse(500, { code: 'internal_error' })],
      ])('AC1 edge: %s is never refreshed and shows the generic message', async (_label, make) => {
        const fetchMock = routedFetch([make()])
        vi.stubGlobal('fetch', fetchMock)
        render(ExtensionPanelPage, { props: { data: actionData } })

        const button = screen.getByText('Run').closest('button') as HTMLButtonElement
        button.click()
        await flush()

        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(callsTo(fetchMock, REFRESH_URL)).toHaveLength(0)
        expect(statusRegion()?.textContent).toContain(GENERIC)
        expect(button.disabled).toBe(false)
        expect(gotoMock).not.toHaveBeenCalled()
      })

      it('DD4: a second 401 after a successful refresh shows the generic message — no loop, no redirect', async () => {
        const fetchMock = routedFetch([expired(), expired()])
        vi.stubGlobal('fetch', fetchMock)
        render(ExtensionPanelPage, { props: { data: actionData } })

        const button = screen.getByText('Run').closest('button') as HTMLButtonElement
        button.click()
        await vi.waitFor(() => expect(statusRegion()?.textContent).toContain(GENERIC))

        expect(fetchMock).toHaveBeenCalledTimes(3)
        expect(callsTo(fetchMock, REFRESH_URL)).toHaveLength(1)
        expect(button.disabled).toBe(false)
        expect(gotoMock).not.toHaveBeenCalled()
      })

      it('AC1: the element stays disabled/aria-busy through 401 -> refresh -> retry; a click during the refresh does nothing', async () => {
        const refreshGate = deferred()
        const fetchMock = routedFetch([expired(), jsonResponse(200, { message: 'Saved' })], () =>
          refreshGate.promise.then(refreshOk)
        )
        vi.stubGlobal('fetch', fetchMock)
        render(ExtensionPanelPage, { props: { data: actionData } })

        const button = screen.getByText('Run').closest('button') as HTMLButtonElement
        button.click()
        await vi.waitFor(() => expect(callsTo(fetchMock, REFRESH_URL)).toHaveLength(1))
        expect(button.disabled).toBe(true)
        expect(button.getAttribute('aria-busy')).toBe('true')

        button.click()
        await flush()
        expect(fetchMock).toHaveBeenCalledTimes(2)

        refreshGate.resolve(undefined)
        await vi.waitFor(() => expect(screen.getByText('Saved')).toBeTruthy())
        expect(fetchMock).toHaveBeenCalledTimes(3)
        expect(button.disabled).toBe(false)
      })

      it.each([
        ['a non-2xx refresh', () => jsonResponse(401, { code: 'refresh_token_missing' })],
        ['a rejected refresh fetch', () => Promise.reject(new TypeError('Failed to fetch'))],
      ])(
        'AC2: %s redirects to /login?reason=session-expired, no retry, no generic error, element re-enabled',
        async (_label, refresh) => {
          const fetchMock = routedFetch([expired()], refresh)
          vi.stubGlobal('fetch', fetchMock)
          render(ExtensionPanelPage, { props: { data: actionData } })

          const button = screen.getByText('Run').closest('button') as HTMLButtonElement
          button.click()
          await settleRedirectLatch()

          expect(fetchMock).toHaveBeenCalledTimes(2)
          expect(gotoMock).toHaveBeenCalledTimes(1)
          expect(String(gotoMock.mock.calls[0]?.[0])).toMatch(/\/login\?reason=session-expired$/)
          expect(statusRegion()?.textContent ?? '').not.toContain(GENERIC)
          expect(statusRegion()?.textContent?.trim() ?? '').toBe('')
          expect(button.disabled).toBe(false)
          expect(button.hasAttribute('aria-busy')).toBe(false)
        }
      )

      it('AC2: two concurrent dead-session clicks share one refresh and redirect at most once', async () => {
        const refreshGate = deferred()
        const fetchMock = routedFetch([expired(), expired()], () =>
          refreshGate.promise.then(() => jsonResponse(401, { code: 'refresh_token_missing' }))
        )
        vi.stubGlobal('fetch', fetchMock)
        render(ExtensionPanelPage, { props: { data: { ...actionData, html: TWO_BUTTONS } } })

        screen.getByText('A').click()
        await vi.waitFor(() => expect(callsTo(fetchMock, REFRESH_URL)).toHaveLength(1))
        screen.getByText('B').click()
        await vi.waitFor(() => expect(callsTo(fetchMock, ACTION_URL)).toHaveLength(2))
        await flush()
        refreshGate.resolve(undefined)
        await settleRedirectLatch()
        await flush()

        expect(callsTo(fetchMock, REFRESH_URL)).toHaveLength(1)
        expect(callsTo(fetchMock, ACTION_URL)).toHaveLength(2)
        expect(gotoMock).toHaveBeenCalledTimes(1)
      })

      it('AC2/AC3: two concurrent live-session clicks share one refresh, both retry, only the later click paints', async () => {
        const refreshGate = deferred()
        const fetchMock = routedFetch(
          [
            expired(),
            expired(),
            jsonResponse(200, { message: 'A result' }),
            jsonResponse(200, { message: 'B result' }),
          ],
          () => refreshGate.promise.then(refreshOk)
        )
        vi.stubGlobal('fetch', fetchMock)
        render(ExtensionPanelPage, { props: { data: { ...actionData, html: TWO_BUTTONS } } })

        const buttonA = screen.getByText('A').closest('button') as HTMLButtonElement
        buttonA.click()
        await vi.waitFor(() => expect(callsTo(fetchMock, REFRESH_URL)).toHaveLength(1))
        screen.getByText('B').click()
        await vi.waitFor(() => expect(callsTo(fetchMock, ACTION_URL)).toHaveLength(2))
        await flush()
        refreshGate.resolve(undefined)
        await vi.waitFor(() => expect(callsTo(fetchMock, ACTION_URL)).toHaveLength(4))
        await flush()

        expect(callsTo(fetchMock, REFRESH_URL)).toHaveLength(1)
        expect(screen.getByText('B result')).toBeTruthy()
        expect(screen.queryByText('A result')).toBeNull()
        expect(buttonA.disabled).toBe(false)
      })

      it('AC3: a newer click accepted during the refresh wins; the older retry never paints', async () => {
        const refreshGate = deferred()
        const fetchMock = routedFetch(
          [
            expired(),
            jsonResponse(200, { html: '<p>B painted</p>' }),
            jsonResponse(200, { html: '<p>A painted</p>' }),
          ],
          () => refreshGate.promise.then(refreshOk)
        )
        vi.stubGlobal('fetch', fetchMock)
        render(ExtensionPanelPage, { props: { data: { ...actionData, html: TWO_BUTTONS } } })

        const buttonA = screen.getByText('A').closest('button') as HTMLButtonElement
        buttonA.click()
        await vi.waitFor(() => expect(callsTo(fetchMock, REFRESH_URL)).toHaveLength(1))
        screen.getByText('B').click()
        await vi.waitFor(() => expect(panelContainer()?.innerHTML).toContain('B painted'))
        refreshGate.resolve(undefined)
        // DD2 — the retry is still issued even though its paint is gated.
        await vi.waitFor(() => expect(callsTo(fetchMock, ACTION_URL)).toHaveLength(3))
        await flush()

        expect(panelContainer()?.innerHTML).toContain('B painted')
        expect(panelContainer()?.innerHTML).not.toContain('A painted')
        expect(buttonA.hasAttribute('disabled')).toBe(false)
        expect(buttonA.hasAttribute('aria-busy')).toBe(false)
      })

      it('AC3: a slot navigation while the retry is in flight drops the retried result', async () => {
        const retry = deferred()
        const fetchMock = routedFetch([expired(), retry.promise])
        vi.stubGlobal('fetch', fetchMock)
        const { rerender } = render(ExtensionPanelPage, { props: { data: actionData } })

        const button = screen.getByText('Run').closest('button') as HTMLButtonElement
        button.click()
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
        await rerender({
          data: { ...actionData, slot: 'other-slot', html: '<p>navigated away</p>' },
        })
        retry.resolve(jsonResponse(200, { html: '<p>stale A</p>', message: 'stale message' }))
        await flush()

        expect(panelContainer()?.innerHTML).toContain('navigated away')
        expect(panelContainer()?.innerHTML).not.toContain('stale A')
        expect(screen.queryByText('stale message')).toBeNull()
        expect(button.hasAttribute('disabled')).toBe(false)
      })

      it('AC3: a generation bump while the retried body is still streaming drops the result', async () => {
        const body = deferred()
        const fetchMock = routedFetch([
          expired(),
          { ok: true, status: 200, json: () => body.promise, clone: () => undefined },
        ])
        vi.stubGlobal('fetch', fetchMock)
        const { rerender } = render(ExtensionPanelPage, { props: { data: actionData } })

        const button = screen.getByText('Run').closest('button') as HTMLButtonElement
        button.click()
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
        await flush()
        await rerender({
          data: { ...actionData, slot: 'other-slot', html: '<p>navigated away</p>' },
        })
        body.resolve({ html: '<p>stale A</p>' })
        await flush()

        expect(panelContainer()?.innerHTML).toContain('navigated away')
        expect(panelContainer()?.innerHTML).not.toContain('stale A')
        expect(button.hasAttribute('disabled')).toBe(false)
        expect(button.hasAttribute('aria-busy')).toBe(false)
      })
    })
  })
})

// Story 61.1 AC4 / DD6 — the module-data path (`/api/v1/extensions/data/*`) has no host-side
// dispatcher today (audited 2026-09-26). This guard keeps it that way: any production source that
// names that path outside a comment must route the request through `fetchWithSessionRefresh()`,
// otherwise it would reintroduce the F3 "401 after access-token expiry, retry never helps" bug.
describe('Story 61.1 AC4: module-data requests go through fetchWithSessionRefresh', () => {
  const WEB_SRC_ROOT = path.join(import.meta.dirname, '../../../../../..')
  const MODULE_DATA_PATTERN = /extensions\/data\b/
  const HELPER_CALL = /\bfetchWithSessionRefresh\s*\(/

  function stripComments(source: string): string {
    return source
      .replaceAll(/\/\*[\s\S]*?\*\//g, '')
      .replaceAll(/<!--[\s\S]*?-->/g, '')
      .replaceAll(/(^|[^:\\])\/\/.*$/gm, '$1')
  }

  /** Returns every file whose comment-stripped source names the module-data path in a statement
   * that is not a `fetchWithSessionRefresh(...)` call. */
  function findUnguardedModuleDataCallers(files: { file: string; source: string }[]): string[] {
    return files
      .filter(({ source }) =>
        stripComments(source)
          .split(/;|\n\s*\n/)
          .some((statement) => MODULE_DATA_PATTERN.test(statement) && !HELPER_CALL.test(statement))
      )
      .map(({ file }) => file)
  }

  function productionSources(): { file: string; source: string }[] {
    return readdirSync(WEB_SRC_ROOT, { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.(ts|js|svelte)$/.test(file) && !/\.(test|spec)\.[tj]s$/.test(file))
      .map((file) => ({ file, source: readFileSync(path.join(WEB_SRC_ROOT, file), 'utf8') }))
  }

  it('scans the real apps/web/src tree', () => {
    const files = productionSources()
    expect(files.some(({ file }) => file.endsWith(path.join('lib', 'api', 'client.ts')))).toBe(true)
  })

  it('no production file issues a module-data request outside fetchWithSessionRefresh', () => {
    expect(findUnguardedModuleDataCallers(productionSources())).toEqual([])
  })

  it('flags a raw fetch/apiFetch to the module-data path and names the file', () => {
    expect(
      findUnguardedModuleDataCallers([
        { file: 'a/+page.svelte', source: "fetch('/api/v1/extensions/data/x')" },
        { file: 'b.ts', source: 'await apiFetch(fetch, `/api/v1/extensions/data/${id}`)' },
      ])
    ).toEqual(['a/+page.svelte', 'b.ts'])
  })

  it('accepts the helper and ignores comments', () => {
    expect(
      findUnguardedModuleDataCallers([
        {
          file: 'ok.ts',
          source:
            "await fetchWithSessionRefresh(fetch, '/api/v1/extensions/data/x', build)\n" +
            '// the /api/v1/extensions/data/* routes are mounted server-side\n' +
            '/* see /api/v1/extensions/data/ */\n<!-- extensions/data/ -->',
        },
      ])
    ).toEqual([])
  })
})
