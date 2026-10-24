import { cleanup, render, screen } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { BASE_EXTENSION_THEME_VARS } from '$lib/security/extension-theme-vars.js'

// Story 69.12: the legacy extension panel page hands its panel container (or the unavailable
// placeholder) to a sub-region. A probe lands right after that container and before the status
// line, never inside the sanitized panel html, and the page's click handler and action state keep
// working through the extracted component.

vi.mock('$app/state', () => ({
  page: { route: { id: '/(app)/extensions/panels/[slot]/[...subpath]' }, params: {} },
}))
vi.mock('$app/navigation', () => ({ goto: vi.fn(async () => undefined) }))

const POINT = 'extensions.panels-detail.panel'
const fills = { [POINT]: [{ marker: `fill:${POINT}` }] }
const ENDPOINT = '/api/v1/extensions/panels/group/actions'
const ACTION_HTML =
  '<button type="button" data-pv-action="test-action" data-pv-action-note="hi"><span>Run</span></button>'
const baseData = {
  slot: 'group',
  subpath: undefined,
  html: '<p>hello</p>' as string | null,
  themeVars: BASE_EXTENSION_THEME_VARS,
  actionEndpoint: undefined as string | undefined,
}

let Panel: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  vi.doMock(`virtual:pv-inject/${POINT}`, () => ({
    default: [{ id: `${POINT}#0`, order: 0, component: probe }],
  }))
  Panel = (await import('./ExtensionPanelContent.svelte')).default as unknown as typeof Panel
}, 60_000)
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const mount = (overrides: Partial<typeof baseData> = {}) =>
  render(Panel, { props: { pageData: { ...baseData, ...overrides }, data: fills } })
const probe = (): HTMLElement => {
  const found = screen
    .getAllByTestId('probe')
    .find((el) => el.textContent?.includes(`"fill:${POINT}"`))
  if (found === undefined) throw new Error(`no probe for ${POINT}`)
  return found
}
const status = () => document.querySelector('[aria-live="polite"]') as HTMLElement
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('ExtensionPanelContent panel sub-region (probe order)', () => {
  it('lands right after the panel container and before the status line', () => {
    mount()
    const container = screen.getByRole('region', { name: 'Extension panel: group' })
    expect(follows(container, probe())).toBe(true)
    expect(probe().previousElementSibling).toBe(container)
    expect(follows(probe(), status())).toBe(true)
    expect(container.contains(probe())).toBe(false)
    expect(screen.getAllByTestId('probe')).toHaveLength(1)
  })

  it('lands right after the unavailable placeholder when the panel degraded', () => {
    mount({ html: null })
    const placeholder = screen.getByText(/temporarily unavailable/i).parentElement as HTMLElement
    expect(probe().previousElementSibling).toBe(placeholder)
    expect(follows(probe(), status())).toBe(true)
    expect(screen.queryByRole('region')).toBeNull()
  })

  it('the point receives the standard point props only', () => {
    mount()
    expect((probe().getAttribute('data-keys') ?? '').split(',')).toEqual([
      'data',
      'params',
      'routeId',
    ])
  })
})

describe('ExtensionPanelContent action state (interaction)', () => {
  it('still dispatches the click to the endpoint and paints the result inside the container', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ html: '<p>replaced</p>' }),
      clone: () => ({ status: 200 }),
    })
    vi.stubGlobal('fetch', fetchMock)
    mount({ html: ACTION_HTML, actionEndpoint: ENDPOINT })
    screen.getByText('Run').click()
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(ENDPOINT)
    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body)).toEqual({
      kind: 'test-action',
      note: 'hi',
    })
    const container = screen.getByRole('region', { name: 'Extension panel: group' })
    expect(container.innerHTML).toBe('<p>replaced</p>')
    expect(probe().previousElementSibling).toBe(container)
  })

  it('keeps the status message in the status line, after the point', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ message: 'Action done' }),
        clone: () => ({ status: 200 }),
      })
    )
    mount({ html: ACTION_HTML, actionEndpoint: ENDPOINT })
    screen.getByText('Run').click()
    await flush()
    expect(status().textContent).toBe('Action done')
    expect(follows(probe(), status())).toBe(true)
  })
})
