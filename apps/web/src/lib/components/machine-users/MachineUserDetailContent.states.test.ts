// @pv-not-guard oracle of PV's own un-composed markup, valid only on PV's tree
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'
import { serializeWithoutNoise } from '$lib/test/dom.js'

// Story 69.14: the machine user detail's client-driven states (issue form errors, the one-time key
// reveal, row action errors, the deactivate error, the overlap input) cannot be reached by the route
// oracles. This pins them: the snapshot was recorded BEFORE the component was split into sub-regions
// and must come out unchanged afterwards. The mount helper below is the only line that follows the
// component's props.

process.env.TZ = 'America/Panama'

const api = vi.hoisted(() => ({
  issueApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
  rotateApiKey: vi.fn(),
  emergencyRevokeApiKey: vi.fn(),
  deactivateMachineUser: vi.fn(),
}))
const invalidateAllMock = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('$lib/api/machine-users.js', () => api)
vi.mock('$app/navigation', () => ({ invalidateAll: invalidateAllMock }))
vi.mock('$app/state', () => ({ page: { route: { id: null }, params: {} } }))

const pageData = {
  notFound: false,
  projectId: 'p-1',
  machineUserId: 'mu-1',
  orgRole: 'owner',
  machineUser: {
    name: 'Deploy bot',
    description: 'Deploys to staging',
    role: 'member',
    createdAt: '2026-09-01T08:00:00.000Z',
    deactivatedAt: null,
    scopeBoundary: { canAccess: ['staging'], cannotAccess: ['production'] },
  },
  apiKeys: {
    items: [
      {
        id: 'k-1',
        name: 'CI key',
        expiresAt: '2026-12-01T00:00:00.000Z',
        lastUsedAt: null,
        isRevoked: false,
      },
      { id: 'k-2', name: 'Old key', expiresAt: null, lastUsedAt: null, isRevoked: true },
    ],
    total: 2,
  },
}

let Content: Component<Record<string, unknown>>
beforeAll(async () => {
  Content = (await import('./MachineUserDetailContent.svelte')).default as unknown as typeof Content
}, 60_000)

const mountContent = () => render(Content, { props: { pageData } })
// Every value is pinned as text so the JSON snapshot stays Prettier-stable.
const asText = (states: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(states).map(([key, value]) => [
      key,
      typeof value === 'string' ? value : JSON.stringify(value),
    ])
  )
const snapshotOf = (container: Element): string => serializeWithoutNoise(container)
const nameInput = (): HTMLInputElement =>
  document.getElementById('issue-key-name') as HTMLInputElement
const confirm = async (label: string, confirmLabel: string) => {
  await fireEvent.click(screen.getByRole('button', { name: label }))
  await fireEvent.click(await screen.findByRole('button', { name: confirmLabel }))
}

function resetScenario() {
  cleanup()
  for (const fn of Object.values(api)) fn.mockReset()
  invalidateAllMock.mockClear()
}
beforeEach(() => {
  resetScenario()
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined) },
  })
})
afterEach(cleanup)

describe('MachineUserDetailContent client states (Story 69.14 pre-split pin)', () => {
  it('renders every interactive state exactly as before the split', async () => {
    const states: Record<string, unknown> = {}

    const blank = mountContent()
    await fireEvent.submit(nameInput().closest('form') as HTMLFormElement)
    states['issue-blank-name'] = snapshotOf(blank.container)
    resetScenario()

    api.issueApiKey.mockRejectedValueOnce(new ApiClientError(400, null, 'name taken'))
    const failed = mountContent()
    await fireEvent.input(nameInput(), { target: { value: ' Fresh ' } })
    await fireEvent.submit(nameInput().closest('form') as HTMLFormElement)
    await screen.findByText('name taken')
    states['issue-api-error'] = snapshotOf(failed.container)
    resetScenario()

    api.issueApiKey.mockRejectedValueOnce(new Error('network'))
    const generic = mountContent()
    await fireEvent.input(nameInput(), { target: { value: 'Fresh' } })
    await fireEvent.submit(nameInput().closest('form') as HTMLFormElement)
    await screen.findByText('Failed to issue API key.')
    states['issue-generic-error'] = snapshotOf(generic.container)
    resetScenario()

    api.issueApiKey.mockResolvedValueOnce({ name: 'Fresh', key: 'pvk_one_time_value' })
    const issued = mountContent()
    await fireEvent.input(nameInput(), { target: { value: ' Fresh ' } })
    await fireEvent.submit(nameInput().closest('form') as HTMLFormElement)
    await screen.findByText('pvk_one_time_value')
    await waitFor(() => expect(invalidateAllMock).toHaveBeenCalled())
    states['issue-ok-reveal'] = snapshotOf(issued.container)
    states['issue-ok-args'] = api.issueApiKey.mock.calls.map((call) => call.slice(1))
    states['issue-ok-invalidated'] = invalidateAllMock.mock.calls.length
    await fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    states['copied'] = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls
    await fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    states['reveal-hidden'] = snapshotOf(issued.container)
    resetScenario()

    api.rotateApiKey.mockResolvedValueOnce({ key: 'pvk_rotated_value' })
    const rotated = mountContent()
    await fireEvent.input(screen.getByLabelText(/Overlap/), { target: { value: '30' } })
    await confirm('Rotate', 'Confirm rotate?')
    await screen.findByText('pvk_rotated_value')
    states['rotate-ok-reveal'] = snapshotOf(rotated.container)
    states['rotate-ok-args'] = api.rotateApiKey.mock.calls.map((call) => call.slice(1))
    resetScenario()

    api.rotateApiKey.mockRejectedValueOnce(new Error('boom'))
    const rotateFailed = mountContent()
    await fireEvent.input(screen.getByLabelText(/Overlap/), { target: { value: '0' } })
    await confirm('Rotate', 'Confirm rotate?')
    await screen.findByText('Failed to rotate key.')
    states['rotate-generic-error'] = snapshotOf(rotateFailed.container)
    states['rotate-default-overlap-args'] = api.rotateApiKey.mock.calls.map((call) => call.slice(1))
    resetScenario()

    api.revokeApiKey.mockRejectedValueOnce(new ApiClientError(409, null, 'already revoked'))
    const revokeFailed = mountContent()
    await confirm('Revoke', 'Confirm revoke?')
    await screen.findByText('already revoked')
    states['revoke-api-error'] = snapshotOf(revokeFailed.container)
    resetScenario()

    invalidateAllMock.mockClear()
    api.revokeApiKey.mockResolvedValueOnce(undefined)
    mountContent()
    await confirm('Revoke', 'Confirm revoke?')
    await waitFor(() => expect(invalidateAllMock).toHaveBeenCalled())
    states['revoke-ok-args'] = api.revokeApiKey.mock.calls.map((call) => call.slice(1))
    resetScenario()

    api.emergencyRevokeApiKey.mockResolvedValueOnce({ newKey: 'pvk_emergency_value' })
    const emergency = mountContent()
    await confirm('Emergency revoke', 'Confirm emergency revoke?')
    await screen.findByText('pvk_emergency_value')
    states['emergency-ok-reveal'] = snapshotOf(emergency.container)
    states['emergency-ok-args'] = api.emergencyRevokeApiKey.mock.calls.map((call) => call.slice(1))
    resetScenario()

    api.emergencyRevokeApiKey.mockRejectedValueOnce(new Error('boom'))
    const emergencyFailed = mountContent()
    await confirm('Emergency revoke', 'Confirm emergency revoke?')
    await screen.findByText('Failed to emergency-revoke key.')
    states['emergency-generic-error'] = snapshotOf(emergencyFailed.container)
    resetScenario()

    api.deactivateMachineUser.mockRejectedValueOnce(new ApiClientError(403, null, 'not allowed'))
    const deactivateFailed = mountContent()
    await confirm('Deactivate', 'Confirm deactivate?')
    await screen.findByText('not allowed')
    states['deactivate-api-error'] = snapshotOf(deactivateFailed.container)
    resetScenario()

    invalidateAllMock.mockClear()
    api.deactivateMachineUser.mockResolvedValueOnce(undefined)
    mountContent()
    await confirm('Deactivate', 'Confirm deactivate?')
    await waitFor(() => expect(invalidateAllMock).toHaveBeenCalled())
    states['deactivate-ok-args'] = api.deactivateMachineUser.mock.calls.map((call) => call.slice(1))

    await expect(`${JSON.stringify(asText(states), null, 2)}\n`).toMatchFileSnapshot(
      './MachineUserDetailContent.states.snapshot.json'
    )
  }, 60_000)
})
