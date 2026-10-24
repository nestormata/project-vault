// @pv-not-guard oracle of PV's own un-composed markup, valid only on PV's tree
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'
import { serializeWithoutNoise } from '$lib/test/dom.js'

// Story 69.12: the verify panel's client-driven states (running, 429, API error, generic error,
// empty range, clean result, failed rows) cannot be reached by the route oracles. This pins them:
// the snapshot was recorded BEFORE the panel was split into sub-regions and must come out unchanged.

const api = vi.hoisted(() => ({ verifyAuditRange: vi.fn() }))
vi.mock('$lib/api/audit.js', () => api)

let Panel: Component<Record<string, unknown>>
beforeAll(async () => {
  Panel = (await import('./AuditVerifyPanel.svelte')).default as unknown as typeof Panel
}, 60_000)

const result = (overrides: Record<string, unknown>) => ({
  summary: '12 events checked, all intact.',
  rowsChecked: 12,
  passed: 12,
  failed: [],
  failedCount: 0,
  failedTruncated: false,
  verifiedAt: '2026-10-01T00:00:00.000Z',
  ...overrides,
})
const asText = (states: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(states).map(([key, value]) => [
      key,
      typeof value === 'string' ? value : JSON.stringify(value),
    ])
  )
const run = async () => {
  await fireEvent.input(screen.getByLabelText('From'), { target: { value: '2026-09-01' } })
  await fireEvent.input(screen.getByLabelText('To'), { target: { value: '2026-09-30' } })
  await fireEvent.click(screen.getByRole('button', { name: 'Run integrity check' }))
}
beforeEach(() => {
  cleanup()
  api.verifyAuditRange.mockReset()
})
afterEach(cleanup)

describe('AuditVerifyPanel client states (Story 69.12 pre-split pin)', () => {
  it('renders every interactive state exactly as before the split', async () => {
    const states: Record<string, unknown> = {}

    const initial = render(Panel)
    states['initial'] = serializeWithoutNoise(initial.container)
    await fireEvent.click(screen.getByRole('button', { name: 'Run integrity check' }))
    states['blank-dates-click-ignored'] = api.verifyAuditRange.mock.calls.length
    cleanup()

    let release: (value: unknown) => void = () => undefined
    api.verifyAuditRange.mockReturnValueOnce(new Promise((resolve) => (release = resolve)))
    const running = render(Panel)
    await run()
    await screen.findByRole('button', { name: 'Checking…' })
    states['running'] = serializeWithoutNoise(running.container)
    release(result({}))
    await screen.findByText('12 events checked, all intact.')
    states['running-then-ok'] = serializeWithoutNoise(running.container)
    states['verify-args'] = api.verifyAuditRange.mock.calls.map((call) => call.slice(1))
    cleanup()

    api.verifyAuditRange.mockRejectedValueOnce(new ApiClientError(429, null, 'slow'))
    const limited = render(Panel)
    await run()
    await screen.findByText(/doing that too quickly/)
    states['rate-limited'] = serializeWithoutNoise(limited.container)
    cleanup()

    api.verifyAuditRange.mockRejectedValueOnce(new ApiClientError(422, null, 'range over 90 days'))
    const apiError = render(Panel)
    await run()
    await screen.findByText('range over 90 days')
    states['api-error'] = serializeWithoutNoise(apiError.container)
    cleanup()

    api.verifyAuditRange.mockRejectedValueOnce(new Error('network'))
    const generic = render(Panel)
    await run()
    await screen.findByText('Integrity check failed')
    states['generic-error'] = serializeWithoutNoise(generic.container)
    cleanup()

    api.verifyAuditRange.mockResolvedValueOnce(result({ rowsChecked: 0, passed: 0 }))
    const empty = render(Panel)
    await run()
    await screen.findByText('No audit events in this range to verify.')
    states['empty-range'] = serializeWithoutNoise(empty.container)
    cleanup()

    api.verifyAuditRange.mockResolvedValueOnce(
      result({
        summary: '12 events checked, 2 failed.',
        failedCount: 2,
        failed: [
          { id: 'f-1', eventType: 'credential.access', timestamp: '2026-09-02T10:00:00.000Z' },
          { id: 'f-2', eventType: 'member.invited', timestamp: '2026-09-03T10:00:00.000Z' },
        ],
      })
    )
    const failed = render(Panel)
    await run()
    await screen.findByText(/2 records failed verification/)
    states['failed-rows'] = serializeWithoutNoise(failed.container)
    cleanup()

    api.verifyAuditRange.mockResolvedValueOnce(
      result({
        failedCount: 1,
        failed: [{ id: 'f-1', eventType: 'credential.access', timestamp: '2026-09-02T10:00:00Z' }],
      })
    )
    const single = render(Panel)
    await run()
    await screen.findByText(/1 record failed verification/)
    states['failed-single'] = serializeWithoutNoise(single.container)
    cleanup()

    api.verifyAuditRange.mockRejectedValueOnce(new Error('network'))
    api.verifyAuditRange.mockResolvedValueOnce(result({}))
    const retry = render(Panel)
    await run()
    await screen.findByText('Integrity check failed')
    await fireEvent.click(screen.getByRole('button', { name: 'Run integrity check' }))
    await screen.findByText('12 events checked, all intact.')
    states['retry-clears-error'] = serializeWithoutNoise(retry.container)
    states['retry-inputs'] = [
      (screen.getByLabelText('From') as HTMLInputElement).value,
      (screen.getByLabelText('To') as HTMLInputElement).value,
    ]

    await expect(`${JSON.stringify(asText(states), null, 2)}\n`).toMatchFileSnapshot(
      './AuditVerifyPanel.states.snapshot.json'
    )
    expect(states['blank-dates-click-ignored']).toBe(0)
  }, 60_000)
})
