import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'

// Story 69.12: the verify card is three sub-regions (date range and button, error, result). A probe
// lands after its own section, receives only the role flags, and the controller that the sections
// share drives the card from the form to the error and the result.

vi.mock('$app/state', () => ({
  page: { route: { id: '/(app)/settings/audit' }, params: {} },
}))
const api = vi.hoisted(() => ({ verifyAuditRange: vi.fn() }))
vi.mock('$lib/api/audit.js', () => api)

const POINTS = [
  'settings.audit.verify-form',
  'settings.audit.verify-error',
  'settings.audit.verify-result',
] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))
const POINT_PROPS = { orgRole: 'owner', allowed: true }

let Panel: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Panel = (await import('./AuditVerifyPanel.svelte')).default as unknown as typeof Panel
}, 60_000)
beforeEach(() => api.verifyAuditRange.mockReset())
afterEach(cleanup)

const mount = () => render(Panel, { props: { pointProps: POINT_PROPS, data: fills } })
const probe = (point: string): HTMLElement => {
  const found = screen
    .getAllByTestId('probe')
    .find((el) => el.textContent?.includes(`"fill:${point}"`))
  if (found === undefined) throw new Error(`no probe for ${point}`)
  return found
}
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
const run = async () => {
  await fireEvent.input(screen.getByLabelText('From'), { target: { value: '2026-09-01' } })
  await fireEvent.input(screen.getByLabelText('To'), { target: { value: '2026-09-30' } })
  await fireEvent.click(screen.getByRole('button', { name: 'Run integrity check' }))
}
const RESULT = {
  summary: '3 events checked, 1 failed.',
  rowsChecked: 3,
  passed: 2,
  failed: [{ id: 'f-1', eventType: 'credential.access', timestamp: '2026-09-02T10:00:00.000Z' }],
  failedCount: 1,
  failedTruncated: false,
  verifiedAt: '2026-10-01T00:00:00.000Z',
}

describe('AuditVerifyPanel sub-regions (probe order)', () => {
  it('idle: the form probe is the last item of the date row, then error and result probes', () => {
    mount()
    const form = probe('settings.audit.verify-form')
    const button = screen.getByRole('button', { name: 'Run integrity check' })
    expect(follows(button, form)).toBe(true)
    expect(form.parentElement?.lastElementChild).toBe(form)
    expect(form.parentElement).toBe(button.parentElement)
    expect(follows(form, probe('settings.audit.verify-error'))).toBe(true)
    expect(
      follows(probe('settings.audit.verify-error'), probe('settings.audit.verify-result'))
    ).toBe(true)
    expect(screen.getAllByTestId('probe')).toHaveLength(3)
  })

  it('an API error: the error probe follows the alert; the result probe stays last in the card', async () => {
    api.verifyAuditRange.mockRejectedValueOnce(new ApiClientError(422, null, 'range over 90 days'))
    mount()
    await run()
    const alert = await screen.findByText('range over 90 days')
    expect(follows(alert, probe('settings.audit.verify-error'))).toBe(true)
    const result = probe('settings.audit.verify-result')
    expect(result.parentElement?.lastElementChild).toBe(result)
  })

  it('a result: the result probe follows the summary and the failed-records list', async () => {
    api.verifyAuditRange.mockResolvedValueOnce(RESULT)
    mount()
    await run()
    const summary = await screen.findByText('3 events checked, 1 failed.')
    const failedRow = screen.getByText(/credential.access/)
    const result = probe('settings.audit.verify-result')
    expect(follows(probe('settings.audit.verify-error'), summary)).toBe(true)
    expect(follows(summary, failedRow)).toBe(true)
    expect(follows(failedRow, result)).toBe(true)
    expect(result.parentElement?.lastElementChild).toBe(result)
  })

  it('the controller connects the sections: the call args, the busy button and the kept dates', async () => {
    let release: (value: unknown) => void = () => undefined
    api.verifyAuditRange.mockReturnValueOnce(new Promise((resolve) => (release = resolve)))
    mount()
    await run()
    expect(await screen.findByRole('button', { name: 'Checking…' })).toBeTruthy()
    expect(api.verifyAuditRange.mock.calls.map((call) => call.slice(1))).toEqual([
      ['2026-09-01T00:00:00.000Z', '2026-09-30T23:59:59.999Z'],
    ])
    release(RESULT)
    await screen.findByText('3 events checked, 1 failed.')
    expect((screen.getByLabelText('From') as HTMLInputElement).value).toBe('2026-09-01')
    expect((screen.getByLabelText('To') as HTMLInputElement).value).toBe('2026-09-30')
  })

  it('each point receives only the role flags, never the dates or the result', () => {
    mount()
    for (const point of POINTS) {
      expect(probe(point).getAttribute('data-keys')).toBe('allowed,data,orgRole,params,routeId')
    }
  })
})
