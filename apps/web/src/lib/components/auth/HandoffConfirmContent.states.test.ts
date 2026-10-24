// @pv-not-guard oracle of PV's own un-composed markup, valid only on PV's tree
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'
import { serializeWithoutNoise } from '$lib/test/dom.js'

// Story 69.13 (DW-547 item 2): the sign-in handoff page switches on the URL it is opened with and on
// the answers of the confirm call, so the route render oracles only ever see one state of it. This
// pins the markup of every state (no or malformed pending sign-in, ready, in flight, MFA, rejected,
// login failed, network error, with and without a configured CentralizeMe origin) plus the calls each
// one makes. A change to the markup of any state must be a deliberate snapshot update.

const api = vi.hoisted(() => ({
  confirmHandoff: vi.fn(),
  getCurrentUser: vi.fn(),
  verifyMfaLogin: vi.fn(),
}))
const gotoMock = vi.hoisted(() => vi.fn(async () => undefined))
const pageMock = vi.hoisted(() => ({
  url: new URL('http://localhost/handoff'),
  route: { id: null },
}))
vi.mock('$lib/api/auth.js', () => api)
vi.mock('$app/navigation', () => ({ goto: gotoMock }))
vi.mock('$app/state', () => ({ page: pageMock }))

const ORIGIN = 'https://app.centralizeme.example'
const PENDING = 'abc123_XYZ-789'

let Content: Component<Record<string, unknown>>
beforeAll(async () => {
  Content = (await import('./HandoffConfirmContent.svelte')).default as unknown as typeof Content
}, 60_000)

function resetScenario() {
  cleanup()
  for (const fn of Object.values(api)) fn.mockReset()
  gotoMock.mockClear()
}
beforeEach(() => {
  document.cookie = 'PARAGLIDE_LOCALE=en; path=/'
  resetScenario()
})
afterEach(cleanup)

const open = (query: string, centralizeMeOrigin: string | null = null) => {
  pageMock.url = new URL(`http://localhost/handoff${query}`)
  return render(Content, { props: { centralizeMeOrigin } })
}
const READY = `?pendingId=${PENDING}&organizationName=Acme%20Corp&accountLabel=Alex%20Account`
const asText = (states: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(states).map(([key, value]) => [
      key,
      typeof value === 'string' ? value : JSON.stringify(value),
    ])
  )
const snapshotOf = (container: Element): string =>
  serializeWithoutNoise(container).replace(/\s+/g, ' ')
const confirm = () => fireEvent.click(screen.getByRole('button', { name: 'Confirm sign-in' }))

describe('HandoffConfirmContent states (Story 69.13 pin)', () => {
  it('renders every state with the markup recorded in the snapshot', async () => {
    const states = new Map<string, unknown>()
    const record = (name: string, view: { container: Element }) => {
      states.set(name, snapshotOf(view.container))
    }

    for (const [name, query] of [
      ['no-params', ''],
      ['empty-pending-id', '?pendingId='],
      ['malformed-pending-id', '?pendingId=bad%20id!'],
    ] as const) {
      record(`${name}`, open(query))
      resetScenario()
      record(`${name}-with-origin`, open(query, ORIGIN))
      resetScenario()
    }

    record('ready', open(READY))
    resetScenario()
    record('ready-with-origin', open(READY, ORIGIN))
    resetScenario()
    record('ready-fallback-names', open(`?pendingId=${PENDING}&organizationName=null`))
    resetScenario()
    record(
      'ready-synthetic-label',
      open(
        `?pendingId=${PENDING}&organizationName=Acme%20Corp&accountLabel=service-provisioned%2Bx%40invalid.projectvault`
      )
    )
    resetScenario()
    record(
      'ready-html-names',
      open(`?pendingId=${PENDING}&organizationName=%3Cb%3EAcme%3C%2Fb%3E&accountLabel=a%26b`)
    )
    resetScenario()

    api.confirmHandoff.mockReturnValue(new Promise(() => undefined))
    const submitting = open(READY)
    await confirm()
    await fireEvent.click(screen.getByRole('button', { name: 'Confirming...' }))
    const cancel = new MouseEvent('click', { bubbles: true, cancelable: true })
    screen.getByRole('link', { name: 'Not me' }).dispatchEvent(cancel)
    states.set('submitting-not-me-default-prevented', cancel.defaultPrevented)
    record('submitting', submitting)
    states.set('submitting-calls', api.confirmHandoff.mock.calls.length)
    resetScenario()

    api.confirmHandoff.mockResolvedValueOnce({ mfaRequired: true, mfaToken: 'mfa-tok-1' })
    const mfa = open(READY)
    await confirm()
    await screen.findByLabelText(/authenticator code/i)
    record('mfa', mfa)
    resetScenario()

    api.confirmHandoff.mockResolvedValueOnce({ mfaRequired: true, mfaToken: 'mfa-tok-1' })
    api.verifyMfaLogin.mockRejectedValueOnce({ code: 'mfa_token_expired' })
    const expired = open(READY, ORIGIN)
    await confirm()
    await fireEvent.input(await screen.findByLabelText(/authenticator code/i), {
      target: { value: '123456' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /verify mfa code/i }))
    await waitFor(() => expect(expired.container.querySelector('button')).toBeNull())
    record('mfa-expired-with-origin', expired)
    states.set('mfa-expired-verify-calls', api.verifyMfaLogin.mock.calls.length)
    resetScenario()

    api.confirmHandoff.mockRejectedValueOnce(new ApiClientError(401, null, 'raw body message'))
    const rejected = open(READY)
    await confirm()
    await waitFor(() => expect(rejected.container.querySelector('[role="alert"]')).not.toBeNull())
    record('rejected', rejected)
    resetScenario()

    api.confirmHandoff.mockRejectedValueOnce(new ApiClientError(401, null, 'raw body message'))
    const rejectedOrigin = open(READY, ORIGIN)
    await confirm()
    await waitFor(() =>
      expect(rejectedOrigin.container.querySelector('a[href^="https://app"]')).not.toBeNull()
    )
    record('rejected-with-origin', rejectedOrigin)
    resetScenario()

    api.confirmHandoff.mockRejectedValueOnce(new ApiClientError(503, null, 'down'))
    const loginFailed = open(READY, ORIGIN)
    await confirm()
    await waitFor(() => expect(loginFailed.container.querySelector('button')).toBeNull())
    record('login-failed-with-origin', loginFailed)
    resetScenario()

    api.confirmHandoff.mockRejectedValueOnce(new ApiClientError(500, null, 'boom'))
    const serverError = open(READY)
    await confirm()
    await waitFor(() =>
      expect(serverError.container.querySelector('[role="alert"]')).not.toBeNull()
    )
    record('other-status-error', serverError)
    resetScenario()

    api.confirmHandoff.mockResolvedValueOnce({ ok: true })
    api.getCurrentUser.mockRejectedValueOnce(new Error('session lookup failed'))
    const noSession = open(READY)
    await confirm()
    await waitFor(() => expect(noSession.container.querySelector('[role="alert"]')).not.toBeNull())
    record('confirmed-but-session-lookup-fails', noSession)
    states.set('confirmed-but-session-lookup-fails-goto', gotoMock.mock.calls.length)
    resetScenario()

    record(
      'ready-padded-synthetic-label',
      open(
        `?pendingId=${PENDING}&organizationName=Acme%20Corp&accountLabel=%20service-provisioned%2Bx%40invalid.projectvault%20`
      )
    )
    resetScenario()

    api.confirmHandoff.mockRejectedValueOnce(new Error('network'))
    const network = open(READY)
    await confirm()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Confirm sign-in' })).not.toBeNull()
    )
    await waitFor(() => expect(network.container.querySelector('[role="alert"]')).not.toBeNull())
    record('network-error', network)
    states.set('network-error-calls', api.confirmHandoff.mock.calls.length)
    resetScenario()

    api.confirmHandoff.mockResolvedValueOnce({ ok: true })
    api.getCurrentUser.mockResolvedValueOnce({ userId: 'u1' })
    open(READY)
    await confirm()
    await waitFor(() => expect(gotoMock).toHaveBeenCalled())
    states.set('success-goto', gotoMock.mock.calls)
    states.set('success-get-current-user-calls', api.getCurrentUser.mock.calls.length)

    await expect(
      `${JSON.stringify(asText(Object.fromEntries(states)), null, 2)}\n`
    ).toMatchFileSnapshot('./HandoffConfirmContent.states.snapshot.json')
  }, 60_000)
})
