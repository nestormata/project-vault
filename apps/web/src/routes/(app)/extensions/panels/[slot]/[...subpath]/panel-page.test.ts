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

    function jsonResponse(status: number, body: unknown) {
      return {
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
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
  })
})
