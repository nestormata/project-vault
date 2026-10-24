import { cleanup, render, screen } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// Story 69.12: the delivery preference card is one sub-region per section (title block, column
// heads, each row). A probe contribution lands after its own section, never between table rows, and
// receives the viewer flags only: never the preferences.

vi.mock('$app/state', () => ({
  page: { route: { id: '/(app)/settings/notifications' }, params: {} },
}))
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy: () => undefined }) }))

const POINTS = [
  'settings.notifications.channels-header',
  'settings.notifications.channels-head',
  'settings.notifications.channels-row',
] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))
const FLAGS = { isAdmin: true, canSendTest: false }
const PREFERENCES = [
  { alertType: 'credential.expiry', channel: 'email', frequency: 'immediate', minSeverity: 'info' },
  {
    alertType: 'credential.expiry',
    channel: 'slack',
    frequency: 'digest_daily',
    minSeverity: 'warning',
  },
]

let Panel: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Panel = (await import('./NotificationPreferencesPanel.svelte')).default as unknown as typeof Panel
}, 60_000)
afterEach(cleanup)

const mount = (preferences: unknown[] = PREFERENCES) =>
  render(Panel, { props: { preferences, flagProps: FLAGS, data: fills } })
const probesFor = (point: string): HTMLElement[] =>
  screen.getAllByTestId('probe').filter((el) => el.textContent?.includes(`"fill:${point}"`))
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

describe('NotificationPreferencesPanel sub-regions (probe order)', () => {
  it('the header probe follows the title block and precedes the table', () => {
    mount()
    const [header] = probesFor('settings.notifications.channels-header')
    const title = screen.getByText('Personal Delivery Preferences')
    expect(follows(screen.getByText(/^Per-org settings/), header as Node)).toBe(true)
    expect(follows(title, header as Node)).toBe(true)
    expect(follows(header as Node, document.querySelector('table') as Node)).toBe(true)
  })

  it('the head probe sits inside the last column head, after its text', () => {
    mount()
    const [head] = probesFor('settings.notifications.channels-head')
    const last = screen.getByRole('columnheader', { name: /Actions/ })
    expect(last.contains(head as Node)).toBe(true)
    expect(last.lastElementChild).toBe(head)
    expect(follows(screen.getByRole('columnheader', { name: 'Min Severity' }), head as Node)).toBe(
      true
    )
  })

  it('each row has its own probe inside its actions form, after the Save button', () => {
    mount()
    const probes = probesFor('settings.notifications.channels-row')
    expect(probes).toHaveLength(2)
    const forms = Array.from(document.querySelectorAll('tbody form[action="?/updatePreference"]'))
    probes.forEach((p) => {
      const form = p.closest('form') as HTMLFormElement
      expect(forms).toContain(form)
      expect(form.lastElementChild).toBe(p)
      expect(follows(form.querySelector('button') as Node, p)).toBe(true)
    })
    expect(new Set(probes.map((p) => p.closest('form'))).size).toBe(2)
  })

  it('no probe lands between table rows', () => {
    mount()
    for (const el of probesFor('settings.notifications.channels-row')) {
      expect(el.closest('td')).not.toBeNull()
    }
    expect(document.querySelector('tbody')?.children.length).toBe(2)
    for (const child of Array.from(document.querySelector('tbody')?.children ?? [])) {
      expect(child.tagName).toBe('TR')
    }
  })

  it('renders no row probe for an empty preference list', () => {
    mount([])
    expect(probesFor('settings.notifications.channels-row')).toHaveLength(0)
    expect(probesFor('settings.notifications.channels-header')).toHaveLength(1)
  })

  it('hands the viewer flags to every point and never the preferences', () => {
    mount()
    for (const el of screen.getAllByTestId('probe')) {
      const keys = (el.getAttribute('data-keys') ?? '').split(',')
      expect(keys).toEqual(expect.arrayContaining(['isAdmin', 'canSendTest']))
      expect(keys).not.toContain('preferences')
      expect(keys).not.toContain('pref')
      expect(el.textContent).not.toContain('credential.expiry')
    }
  })
})
