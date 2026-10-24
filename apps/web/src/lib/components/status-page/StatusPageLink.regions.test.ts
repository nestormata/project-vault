import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Story 69.12: the "Shareable link" card is two sub-regions (the header row, the link display)
// inside the card that keeps its own end point. A probe lands after its own section, contributions
// get flags only (never the link or its token), and the callbacks the page owns are what the
// buttons call.

vi.mock('$app/state', () => ({
  page: { route: { id: '/(app)/projects/[projectId]/status-page' }, params: {} },
}))

const POINTS = [
  'project.status-page.link-header',
  'project.status-page.link-display',
  'project.status-page.link',
] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))
const URL_WITH_TOKEN = 'https://vault.example.test/status/tok-secret-1'

let Link: Component<Record<string, unknown>>
const callbacks = { onRegenerate: vi.fn(), onDisable: vi.fn(), onCopy: vi.fn() }
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Link = (await import('./StatusPageLink.svelte')).default as unknown as typeof Link
}, 60_000)
beforeEach(() => {
  for (const fn of Object.values(callbacks)) fn.mockReset()
})
afterEach(cleanup)

const mount = (overrides: Record<string, unknown> = {}) =>
  render(Link, {
    props: {
      project: { id: 'p1', name: 'Project' },
      publicUrl: URL_WITH_TOKEN,
      legacyToken: false,
      copied: false,
      isBusy: false,
      ...callbacks,
      data: fills,
      ...overrides,
    },
  })
const probe = (point: string): HTMLElement => {
  const found = screen
    .getAllByTestId('probe')
    .find((el) => el.textContent?.includes(`"fill:${point}"`))
  if (found === undefined) throw new Error(`no probe for ${point}`)
  return found
}
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

describe('StatusPageLink sub-regions (probe order)', () => {
  it('header, display and the card end point follow their own section in order', () => {
    mount()
    const header = probe('project.status-page.link-header')
    const display = probe('project.status-page.link-display')
    const end = probe('project.status-page.link')
    const disable = screen.getByRole('button', { name: 'Disable' })
    expect(follows(disable, header)).toBe(true)
    expect(header.previousElementSibling).toBe(disable)
    expect(header.parentElement?.lastElementChild).toBe(header)
    expect(follows(header, screen.getByText(URL_WITH_TOKEN))).toBe(true)
    expect(follows(screen.getByRole('button', { name: 'Copy' }), display)).toBe(true)
    expect(follows(display, end)).toBe(true)
    expect(end.parentElement?.lastElementChild).toBe(end)
    expect(screen.getAllByTestId('probe')).toHaveLength(3)
  })

  it.each([
    ['legacy link', { publicUrl: null, legacyToken: true }, /created before persistent links/],
    ['unavailable link', { publicUrl: null }, /temporarily unavailable/],
  ])('the display point follows the %s notice', (_name, overrides, notice) => {
    mount(overrides)
    expect(follows(screen.getByText(notice), probe('project.status-page.link-display'))).toBe(true)
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull()
  })

  it('points receive flags and the project, and never the link or its token', () => {
    mount()
    for (const point of POINTS) {
      const found = probe(point)
      expect((found.getAttribute('data-keys') ?? '').split(',')).toEqual(
        expect.arrayContaining(['hasPublicUrl', 'isLegacy', 'project'])
      )
      expect(found.textContent).not.toContain('tok-secret-1')
      expect(found.textContent).not.toContain('publicUrl')
      expect(JSON.parse(found.textContent ?? '{}')).toMatchObject({
        hasPublicUrl: true,
        isLegacy: false,
      })
    }
    cleanup()
    mount({ publicUrl: null, legacyToken: true })
    expect(JSON.parse(probe('project.status-page.link-header').textContent ?? '{}')).toMatchObject({
      hasPublicUrl: false,
      isLegacy: true,
    })
  })
})

describe('StatusPageLink callbacks (interaction)', () => {
  it('regenerates only after the second click, disables and copies on one click', async () => {
    mount()
    await fireEvent.click(screen.getByRole('button', { name: 'Regenerate link' }))
    expect(callbacks.onRegenerate).not.toHaveBeenCalled()
    await fireEvent.click(await screen.findByRole('button', { name: /Confirm/ }))
    expect(callbacks.onRegenerate).toHaveBeenCalledTimes(1)
    await fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
    expect(callbacks.onDisable).toHaveBeenCalledTimes(1)
    await fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(callbacks.onCopy).toHaveBeenCalledTimes(1)
  })

  it('labels the regenerate action as a migration for a legacy link and shows the copied state', () => {
    mount({ publicUrl: null, legacyToken: true })
    expect(screen.getByRole('button', { name: 'Migrate to persistent link' })).toBeTruthy()
    cleanup()
    mount({ copied: true })
    expect(screen.getByRole('button', { name: 'Copied!' })).toBeTruthy()
  })

  it('disables regenerate and disable while the page is busy', () => {
    mount({ isBusy: true })
    for (const name of ['Regenerate link', 'Disable']) {
      expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true)
    }
  })
})
