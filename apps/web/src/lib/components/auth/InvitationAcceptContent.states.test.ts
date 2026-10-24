// @pv-not-guard oracle of PV's own un-composed markup, valid only on PV's tree
import { cleanup, render, waitFor } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'
import { serializeWithoutNoise } from '$lib/test/dom.js'

// Story 69.13 (DW-547 item 2): the invitation page decides everything after mount from the token in
// the URL and from the answers of the peek, session and accept calls, so the route render oracles only
// ever see "Checking your invitation...". This pins the markup of each state and the navigation each
// branch performs. A change to any state must be a deliberate snapshot update.

const api = vi.hoisted(() => ({
  peekInvitation: vi.fn(),
  acceptInvitation: vi.fn(),
  getCurrentUser: vi.fn(),
  lookupSsoDomain: vi.fn(),
}))
const gotoMock = vi.hoisted(() => vi.fn(async () => undefined))
const themeMock = vi.hoisted(() => ({ setPreAuthTheme: vi.fn(), writePreAuthThemeCache: vi.fn() }))
const pageMock = vi.hoisted(() => ({
  url: new URL('http://localhost/invitations/accept'),
  route: { id: null },
}))
vi.mock('$lib/api/invitations.js', () => ({
  peekInvitation: api.peekInvitation,
  acceptInvitation: api.acceptInvitation,
}))
vi.mock('$lib/api/auth.js', () => ({
  getCurrentUser: api.getCurrentUser,
  lookupSsoDomain: api.lookupSsoDomain,
}))
vi.mock('$lib/state/theme.svelte.js', () => themeMock)
vi.mock('$app/navigation', () => ({ goto: gotoMock }))
vi.mock('$app/state', () => ({ page: pageMock }))

let Content: Component<Record<string, unknown>>
beforeAll(async () => {
  Content = (await import('./InvitationAcceptContent.svelte')).default as unknown as typeof Content
}, 60_000)

function resetScenario() {
  cleanup()
  for (const fn of Object.values(api)) fn.mockReset()
  api.lookupSsoDomain.mockResolvedValue({ ssoRequired: false })
  gotoMock.mockClear()
}
beforeEach(() => {
  document.cookie = 'PARAGLIDE_LOCALE=en; path=/'
  resetScenario()
})
afterEach(cleanup)

const open = (query: string) => {
  pageMock.url = new URL(`http://localhost/invitations/accept${query}`)
  return render(Content, { props: {} })
}
const asText = (states: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(states).map(([key, value]) => [
      key,
      typeof value === 'string' ? value : JSON.stringify(value),
    ])
  )
const snapshotOf = (container: Element): string =>
  serializeWithoutNoise(container).replace(/\s+/g, ' ')
const settled = (view: { container: Element }) =>
  waitFor(() => expect(view.container.textContent).not.toContain('Checking your invitation'))

describe('InvitationAcceptContent states (Story 69.13 pin)', () => {
  it('renders every state and branch as recorded in the snapshot', async () => {
    const states: Record<string, unknown> = {}

    api.peekInvitation.mockReturnValue(new Promise(() => undefined))
    states['loading'] = snapshotOf(open('?token=tok-1').container)
    resetScenario()

    const missing = open('')
    await settled(missing)
    states['missing-token'] = snapshotOf(missing.container)
    states['missing-token-peeks'] = api.peekInvitation.mock.calls.length
    resetScenario()

    api.peekInvitation.mockRejectedValueOnce(new ApiClientError(404, null, 'nf'))
    const gone = open('?token=tok-1')
    await settled(gone)
    states['peek-api-error'] = snapshotOf(gone.container)
    resetScenario()

    api.peekInvitation.mockRejectedValueOnce(new Error('network down'))
    const network = open('?token=tok-1')
    await settled(network)
    states['peek-network-error'] = snapshotOf(network.container)
    resetScenario()

    api.peekInvitation.mockResolvedValueOnce({
      email: 'invitee-new',
      accountExists: false,
      nativeLoginEnabled: false,
    })
    const external = open('?token=tok%20%26%201')
    await settled(external)
    states['external-signin'] = snapshotOf(external.container)
    resetScenario()

    api.peekInvitation.mockResolvedValueOnce({ email: 'invitee-new', accountExists: false })
    open('?token=tok-1')
    await waitFor(() => expect(gotoMock).toHaveBeenCalled())
    states['no-account-goto'] = gotoMock.mock.calls
    states['no-account-peek-args'] = api.peekInvitation.mock.calls.map((call) => call.slice(1))
    resetScenario()

    api.peekInvitation.mockResolvedValueOnce({ email: 'invitee-existing', accountExists: true })
    api.getCurrentUser.mockRejectedValueOnce(new Error('401'))
    open('?token=tok-1')
    await waitFor(() => expect(gotoMock).toHaveBeenCalled())
    states['signed-out-goto'] = gotoMock.mock.calls
    states['signed-out-accepts'] = api.acceptInvitation.mock.calls.length
    resetScenario()

    api.peekInvitation.mockResolvedValueOnce({ email: 'invitee-existing', accountExists: true })
    api.getCurrentUser.mockResolvedValueOnce({ userId: 'u1' })
    api.acceptInvitation.mockResolvedValueOnce({ projectId: 'p-1' })
    open('?token=tok-1')
    await waitFor(() => expect(gotoMock).toHaveBeenCalled())
    states['accepted-goto'] = gotoMock.mock.calls
    states['accepted-args'] = api.acceptInvitation.mock.calls.map((call) => call.slice(1))
    resetScenario()

    api.peekInvitation.mockResolvedValueOnce({ email: 'invitee-existing', accountExists: true })
    api.getCurrentUser.mockResolvedValueOnce({ userId: 'u1' })
    api.acceptInvitation.mockRejectedValueOnce(new ApiClientError(409, null, 'conflict'))
    const failed = open('?token=tok-1')
    await settled(failed)
    states['accept-error'] = snapshotOf(failed.container)
    states['accept-error-goto'] = gotoMock.mock.calls.length

    await expect(`${JSON.stringify(asText(states), null, 2)}\n`).toMatchFileSnapshot(
      './InvitationAcceptContent.states.snapshot.json'
    )
  }, 60_000)
})
