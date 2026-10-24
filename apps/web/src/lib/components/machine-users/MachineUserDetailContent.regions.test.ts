import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Story 69.14: the machine user detail's sections are sub-regions. A probe contribution lands
// BETWEEN the two PV sections it was meant to sit between, gated sections render no probe for a
// caller who cannot see them, and the key state has ONE owner shared by the reveal, issue and list
// regions.

const api = vi.hoisted(() => ({
  issueApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
  rotateApiKey: vi.fn(),
  emergencyRevokeApiKey: vi.fn(),
  deactivateMachineUser: vi.fn(),
}))
vi.mock('$lib/api/machine-users.js', () => api)
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(async () => undefined) }))
vi.mock('$app/state', () => ({ page: { route: { id: null }, params: {} } }))

const POINTS = [
  'project.machine-users-detail.summary',
  'project.machine-users-detail.deactivate',
  'project.machine-users-detail.key-reveal',
  'project.machine-users-detail.key-issue',
  'project.machine-users-detail.keys',
] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))
const [SUMMARY, DEACTIVATE, REVEAL, ISSUE, KEYS] = POINTS

const baseData = (overrides: Record<string, unknown> = {}) => ({
  notFound: false,
  projectId: 'p-1',
  machineUserId: 'mu-1',
  orgRole: 'owner',
  machineUser: {
    name: 'Deploy bot',
    description: null,
    role: 'member',
    createdAt: '2026-09-01T08:00:00.000Z',
    deactivatedAt: null,
    scopeBoundary: { canAccess: ['staging'], cannotAccess: ['production'] },
  },
  apiKeys: {
    items: [
      { id: 'k-1', name: 'CI key', expiresAt: null, lastUsedAt: null, isRevoked: false },
      { id: 'k-2', name: 'Old key', expiresAt: null, lastUsedAt: null, isRevoked: true },
    ],
    total: 2,
  },
  ...overrides,
})

let Content: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Content = (await import('./MachineUserDetailContent.svelte')).default as unknown as typeof Content
}, 60_000)
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
})
afterEach(cleanup)

const mount = (overrides: Record<string, unknown> = {}) =>
  render(Content, { props: { pageData: baseData(overrides), data: fills } })
const probes = (point: string): HTMLElement[] =>
  screen.queryAllByTestId('probe').filter((el) => el.textContent?.includes(`"fill:${point}"`))
const probe = (point: string): HTMLElement => {
  const found = probes(point)[0]
  if (found === undefined) throw new Error(`no probe for ${point}`)
  return found
}
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
const nameInput = (): HTMLInputElement =>
  document.getElementById('issue-key-name') as HTMLInputElement
const issueKey = async (name: string) => {
  await fireEvent.input(nameInput(), { target: { value: name } })
  await fireEvent.submit(nameInput().closest('form') as HTMLFormElement)
}

describe('MachineUserDetailContent sub-regions (probe order)', () => {
  it('summary: after the scope boundary, before the deactivate control', () => {
    mount()
    const summary = probe(SUMMARY)
    expect(follows(screen.getByText('Cannot access'), summary)).toBe(true)
    expect(follows(summary, screen.getByRole('button', { name: 'Deactivate' }))).toBe(true)
  })

  it('deactivate: after the Deactivate button, inside the card, before the issue form', () => {
    mount()
    const deactivate = probe(DEACTIVATE)
    expect(follows(screen.getByRole('button', { name: 'Deactivate' }), deactivate)).toBe(true)
    expect(follows(deactivate, screen.getByText('Issue a new API key'))).toBe(true)
    expect(deactivate.closest('.rounded-3xl')).toBe(probe(SUMMARY).closest('.rounded-3xl'))
  })

  it('key-issue: after the Issue key button, before the key list', () => {
    mount()
    const issue = probe(ISSUE)
    expect(follows(screen.getByRole('button', { name: 'Issue key' }), issue)).toBe(true)
    expect(follows(issue, screen.getByRole('heading', { name: 'API keys' }))).toBe(true)
  })

  it('keys: after the last key, before the back link', () => {
    mount()
    const keys = probe(KEYS)
    expect(follows(screen.getByText('Old key'), keys)).toBe(true)
    expect(follows(keys, screen.getByRole('link', { name: 'Back to machine users' }))).toBe(true)
  })

  it('keys: after the empty state when no key was issued', () => {
    mount({ apiKeys: { items: [], total: 0 } })
    expect(follows(screen.getByText(/No API keys have been issued/), probe(KEYS))).toBe(true)
  })

  it('renders no key-reveal probe until a key is shown', () => {
    mount()
    expect(probes(REVEAL)).toHaveLength(0)
  })
})

describe('MachineUserDetailContent gating', () => {
  it('a viewer gets no deactivate and no issue probe', () => {
    mount({ orgRole: 'viewer' })
    expect(probes(DEACTIVATE)).toHaveLength(0)
    expect(probes(ISSUE)).toHaveLength(0)
    expect(probes(SUMMARY)).toHaveLength(1)
    expect(probes(KEYS)).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Rotate' })).toBeNull()
  })

  it('a deactivated machine user gets no deactivate and no issue probe', () => {
    mount({
      machineUser: { ...baseData().machineUser, deactivatedAt: '2026-10-10T00:00:00.000Z' },
    })
    expect(probes(DEACTIVATE)).toHaveLength(0)
    expect(probes(ISSUE)).toHaveLength(0)
    expect(screen.getByText('Deactivated')).toBeTruthy()
  })

  it('renders no sub-region when the machine user is not found', () => {
    mount({ notFound: true, machineUser: null })
    expect(screen.queryAllByTestId('probe')).toHaveLength(0)
    expect(screen.getByText('Machine user not found')).toBeTruthy()
  })
})

describe('MachineUserDetailContent key state (one owner)', () => {
  it('a key issued in the form is revealed in the reveal region, then hidden', async () => {
    api.issueApiKey.mockResolvedValueOnce({ name: 'Fresh', key: 'pvk_fresh_value' })
    mount()
    await issueKey(' Fresh ')
    await screen.findByText('pvk_fresh_value')
    const reveal = probe(REVEAL)
    expect(follows(screen.getByRole('button', { name: 'Hide' }), reveal)).toBe(true)
    expect(follows(reveal, screen.getByText('Issue a new API key'))).toBe(true)
    expect(nameInput().value).toBe('')
    await fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(screen.queryByText('pvk_fresh_value')).toBeNull()
    expect(probes(REVEAL)).toHaveLength(0)
  })

  it('a key rotated in the list is revealed in the reveal region with the chosen overlap', async () => {
    api.rotateApiKey.mockResolvedValueOnce({ key: 'pvk_rotated_value' })
    mount()
    await fireEvent.input(screen.getByLabelText(/Overlap/), { target: { value: '30' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Rotate' }))
    await fireEvent.click(await screen.findByRole('button', { name: 'Confirm rotate?' }))
    await screen.findByText('pvk_rotated_value')
    expect(api.rotateApiKey.mock.calls.map((call) => call.slice(1))).toEqual([['mu-1', 'k-1', 30]])
    expect(probes(REVEAL)).toHaveLength(1)
    expect(screen.getByText(/CI key \(rotated\)/)).toBeTruthy()
  })

  it('a failed row action reports in the list region and keeps the issue form untouched', async () => {
    api.revokeApiKey.mockRejectedValueOnce(new Error('boom'))
    mount()
    await fireEvent.input(nameInput(), { target: { value: 'typed' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    await fireEvent.click(await screen.findByRole('button', { name: 'Confirm revoke?' }))
    const error = await screen.findByText('Failed to revoke key.')
    expect(follows(screen.getByRole('heading', { name: 'API keys' }), error)).toBe(true)
    expect(nameInput().value).toBe('typed')
  })

  it('a failed issue keeps the typed name and reports under the form', async () => {
    api.issueApiKey.mockRejectedValueOnce(new Error('boom'))
    mount()
    await issueKey('Fresh')
    const error = await screen.findByText('Failed to issue API key.')
    expect(nameInput().value).toBe('Fresh')
    expect(follows(screen.getByRole('button', { name: 'Issue key' }), error)).toBe(true)
    expect(follows(error, probe(ISSUE))).toBe(true)
  })

  it('the deactivate error stays inside the card and does not touch the key errors', async () => {
    api.deactivateMachineUser.mockRejectedValueOnce(new Error('boom'))
    mount()
    await fireEvent.click(screen.getByRole('button', { name: 'Deactivate' }))
    await fireEvent.click(await screen.findByRole('button', { name: 'Confirm deactivate?' }))
    const error = await screen.findByText('Failed to deactivate machine user.')
    expect(error.closest('.rounded-3xl')).not.toBeNull()
    expect(screen.queryByText('Failed to revoke key.')).toBeNull()
  })
})
