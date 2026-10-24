import { cleanup, render, screen } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// Story 69.12: each machine key dormancy alert card holds two sub-regions (the details, the actions
// row). A probe lands after its own section, once per alert, and the revoke confirmation still
// guards the irreversible revoke.

vi.mock('$app/state', () => ({
  page: { route: { id: '/(app)/notifications' }, params: {} },
}))
const submitHandlers = vi.hoisted(() => new Map<string, (input: { cancel: () => void }) => void>())
vi.mock('$app/forms', () => ({
  enhance: (
    form: HTMLFormElement,
    submit?: (input: { cancel: () => void }) => void
  ): { destroy: () => void } => {
    if (submit !== undefined) submitHandlers.set(form.getAttribute('action') ?? '', submit)
    return { destroy: () => undefined }
  },
}))

const POINTS = [
  'notifications.home.machine-dormancy-details',
  'notifications.home.machine-dormancy-actions',
] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))
const ALERT = {
  id: 'a-1',
  machineUserId: 'mu-1',
  machineUserName: 'Deploy bot',
  keyId: 'k-1',
  keyName: 'CI key',
  lastUsedAt: null,
  projectId: 'p-1',
  createdAt: '2026-09-01T08:00:00.000Z',
}

let Alerts: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Alerts = (await import('./MachineDormancyAlerts.svelte')).default as unknown as typeof Alerts
}, 60_000)
afterEach(() => {
  cleanup()
  submitHandlers.clear()
  vi.unstubAllGlobals()
})

const mount = (dormancyAlerts: unknown[] = [ALERT]) =>
  render(Alerts, { props: { dormancyAlerts, data: fills } })
const probes = (point: string): HTMLElement[] =>
  screen.getAllByTestId('probe').filter((el) => el.textContent?.includes(`"fill:${point}"`))
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

describe('MachineDormancyAlerts sub-regions (probe order)', () => {
  it('details follow the last-used line and precede the actions row', () => {
    mount()
    const [details] = probes(POINTS[0])
    expect(follows(screen.getByText(/Last used:/), details as Node)).toBe(true)
    expect(follows(details as Node, screen.getByRole('button', { name: 'Dismiss' }))).toBe(true)
    expect(details?.previousElementSibling).toBe(screen.getByText(/Last used:/))
  })

  it('actions are the last item of the actions row, after the machine user link', () => {
    mount()
    const [actions] = probes(POINTS[1])
    const link = screen.getByRole('link', { name: 'View machine user →' })
    expect(follows(link, actions as Node)).toBe(true)
    expect(actions?.previousElementSibling).toBe(link)
    expect(actions?.parentElement?.lastElementChild).toBe(actions)
  })

  it('renders each point once per alert and none for an empty list', () => {
    mount([ALERT, { ...ALERT, id: 'a-2', keyName: 'Nightly' }])
    for (const point of POINTS) expect(probes(point)).toHaveLength(2)
    cleanup()
    mount([])
    expect(screen.queryAllByTestId('probe')).toHaveLength(0)
  })

  it('points receive the standard point props and nothing of the alert', () => {
    mount()
    for (const point of POINTS) {
      const [found] = probes(point)
      expect((found?.getAttribute('data-keys') ?? '').split(',')).toEqual([
        'data',
        'params',
        'routeId',
      ])
      expect(found?.textContent).not.toContain('CI key')
    }
  })
})

describe('MachineDormancyAlerts actions (interaction)', () => {
  it('asks for a confirmation before the revoke and cancels the submit when declined', () => {
    mount()
    const confirmMock = vi.fn(() => false)
    vi.stubGlobal('confirm', confirmMock)
    const cancel = vi.fn()
    submitHandlers.get('?/revokeDormantKey')?.({ cancel })
    expect(confirmMock).toHaveBeenCalledWith(
      'Revoke the key "CI key" for Deploy bot? This cannot be undone.'
    )
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('lets the revoke through once confirmed', () => {
    mount()
    vi.stubGlobal(
      'confirm',
      vi.fn(() => true)
    )
    const cancel = vi.fn()
    submitHandlers.get('?/revokeDormantKey')?.({ cancel })
    expect(cancel).not.toHaveBeenCalled()
  })

  it('posts the machine user and key ids with the extend and revoke forms', () => {
    mount()
    for (const action of ['?/extendDormancy', '?/revokeDormantKey']) {
      const form = document.querySelector(`form[action="${action}"]`) as HTMLFormElement
      expect((form.elements.namedItem('machineUserId') as HTMLInputElement).value).toBe('mu-1')
      expect((form.elements.namedItem('keyId') as HTMLInputElement).value).toBe('k-1')
    }
    const dismiss = document.querySelector('form[action="?/dismissDormancyAlert"]')
    expect((dismiss?.querySelector('[name="alertId"]') as HTMLInputElement).value).toBe('a-1')
  })
})
