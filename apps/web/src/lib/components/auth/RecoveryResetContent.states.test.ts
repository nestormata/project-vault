// @pv-not-guard oracle of PV's own un-composed markup, valid only on PV's tree
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'
import { serializeWithoutNoise } from '$lib/test/dom.js'

// Story 69.14: the recovery page's states all come from client calls after mount (link status, MFA
// opt-in, submit errors, the recovery codes), so the route oracles only ever see "Checking your
// recovery link...". This pins them: the snapshot was recorded BEFORE the component was split into
// sub-regions and must come out unchanged afterwards. The mount helper is the only line that follows
// the component's props.

const api = vi.hoisted(() => ({
  peekRecovery: vi.fn(),
  startRecoveryMfa: vi.fn(),
  completeRecovery: vi.fn(),
}))
const gotoMock = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('$lib/api/recovery.js', () => api)
vi.mock('$app/navigation', () => ({ goto: gotoMock }))
vi.mock('$app/state', () => ({ page: { route: { id: null }, params: { token: 'tok-1' } } }))

let Content: Component<Record<string, unknown>>
beforeAll(async () => {
  Content = (await import('./RecoveryResetContent.svelte')).default as unknown as typeof Content
}, 60_000)

function resetScenario() {
  cleanup()
  for (const fn of Object.values(api)) fn.mockReset()
  gotoMock.mockClear()
}
beforeEach(resetScenario)
afterEach(cleanup)

const mountContent = () => render(Content, { props: {} })
const snapshotOf = (container: Element): string => serializeWithoutNoise(container)
const password = (): HTMLInputElement =>
  document.getElementById('recovery-new-password') as HTMLInputElement
const submit = () => fireEvent.submit(password().closest('form') as HTMLFormElement)
const peekFails = (code: string | undefined) =>
  api.peekRecovery.mockRejectedValueOnce(new ApiClientError(404, code ? { code } : null, 'nope'))

async function openReady() {
  api.peekRecovery.mockResolvedValueOnce({ email: 'a.b', mfaCurrentlyEnrolled: false })
  const view = mountContent()
  await screen.findByText('Set a new password')
  return view
}
async function enableMfa() {
  api.startRecoveryMfa.mockResolvedValueOnce({
    otpauthUrl: 'otpauth.example',
    secret: 'SECRETKEY',
    qrCodeSvg: '<svg></svg>',
  })
  await fireEvent.click(screen.getByRole('checkbox'))
  await screen.findByText(/Manual entry key/)
}

describe('RecoveryResetContent states (Story 69.14 pre-split pin)', () => {
  it('renders every state exactly as before the split', async () => {
    const states: Record<string, unknown> = {}

    api.peekRecovery.mockReturnValue(new Promise(() => undefined))
    const loading = mountContent()
    states['loading'] = snapshotOf(loading.container)
    resetScenario()

    for (const [name, code] of [
      ['not-found', 'recovery_token_not_found'],
      ['expired', 'recovery_token_expired'],
      ['used', 'recovery_token_used'],
      ['superseded', 'recovery_token_superseded'],
      ['unknown-code', 'something_else'],
      ['no-code', undefined],
    ] as const) {
      peekFails(code)
      const view = mountContent()
      await waitFor(() => expect(view.container.querySelector('h1')).not.toBeNull())
      states[`status-${name}`] = snapshotOf(view.container)
      resetScenario()
    }
    api.peekRecovery.mockRejectedValueOnce(new Error('network'))
    const network = mountContent()
    await screen.findByText('Something went wrong')
    states['status-network-error'] = snapshotOf(network.container)
    resetScenario()

    const ready = await openReady()
    states['ready'] = snapshotOf(ready.container)
    states['peek-args'] = api.peekRecovery.mock.calls.map((call) => call.slice(1))
    resetScenario()

    const mfaOn = await openReady()
    await enableMfa()
    states['mfa-on'] = snapshotOf(mfaOn.container)
    states['mfa-start-args'] = api.startRecoveryMfa.mock.calls.map((call) => call.slice(1))
    await fireEvent.click(screen.getByRole('checkbox'))
    states['mfa-toggled-off-keeps-secret'] = snapshotOf(mfaOn.container)
    await fireEvent.click(screen.getByRole('checkbox'))
    states['mfa-toggled-on-again'] = snapshotOf(mfaOn.container)
    states['mfa-start-calls'] = api.startRecoveryMfa.mock.calls.length
    resetScenario()

    const mfaFails = await openReady()
    api.startRecoveryMfa.mockRejectedValueOnce(new Error('nope'))
    await fireEvent.click(screen.getByRole('checkbox'))
    await screen.findByText(/Could not start MFA re-enrollment/)
    states['mfa-start-error'] = snapshotOf(mfaFails.container)
    resetScenario()

    const incomplete = await openReady()
    await enableMfa()
    await fireEvent.input(password(), { target: { value: 'a-very-long-password' } })
    await fireEvent.input(document.getElementById('recovery-totp') as HTMLElement, {
      target: { value: '12' },
    })
    await submit()
    await screen.findByText(/Enter the 6-digit code/)
    states['mfa-incomplete-code'] = snapshotOf(incomplete.container)
    states['mfa-incomplete-completed'] = api.completeRecovery.mock.calls.length
    resetScenario()

    api.completeRecovery.mockRejectedValueOnce(new ApiClientError(400, null, 'password too weak'))
    const apiError = await openReady()
    await fireEvent.input(password(), { target: { value: 'weak' } })
    await submit()
    await screen.findByText('password too weak')
    states['submit-api-error'] = snapshotOf(apiError.container)
    resetScenario()

    api.completeRecovery.mockRejectedValueOnce(new Error('network'))
    const genericError = await openReady()
    await fireEvent.input(password(), { target: { value: 'weak' } })
    await submit()
    await screen.findByText('Could not complete account recovery.')
    states['submit-generic-error'] = snapshotOf(genericError.container)
    resetScenario()

    api.completeRecovery.mockResolvedValueOnce({ email: 'a.b', sessionsRevoked: 1 })
    await openReady()
    await fireEvent.input(password(), { target: { value: 'a-very-long-password' } })
    await submit()
    await waitFor(() => expect(gotoMock).toHaveBeenCalled())
    states['submit-ok-args'] = api.completeRecovery.mock.calls.map((call) => call.slice(1))
    states['submit-ok-goto'] = gotoMock.mock.calls
    resetScenario()

    api.completeRecovery.mockResolvedValueOnce({
      email: 'a.b',
      sessionsRevoked: 1,
      recoveryCodes: ['code-one', 'code-two'],
    })
    const withCodes = await openReady()
    await enableMfa()
    await fireEvent.input(password(), { target: { value: 'a-very-long-password' } })
    await fireEvent.input(document.getElementById('recovery-totp') as HTMLElement, {
      target: { value: '123456' },
    })
    await submit()
    await screen.findByText('Save your recovery codes')
    states['recovery-codes'] = snapshotOf(withCodes.container)
    states['recovery-codes-args'] = api.completeRecovery.mock.calls.map((call) => call.slice(1))
    states['recovery-codes-goto-before'] = gotoMock.mock.calls.length
    await fireEvent.click(screen.getByRole('button', { name: 'Continue to login' }))
    states['recovery-codes-goto-after'] = gotoMock.mock.calls

    await expect(`${JSON.stringify(states, null, 2)}\n`).toMatchFileSnapshot(
      './RecoveryResetContent.states.snapshot.json'
    )
  }, 60_000)
})
