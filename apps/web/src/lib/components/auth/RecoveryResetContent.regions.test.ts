import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'

// Story 69.14: the recovery page's panels are sub-regions. A probe contribution lands BETWEEN the
// two PV sections it was meant to sit between, the typed password, the MFA secret and the recovery
// codes never reach a point, and the recovery state has ONE owner shared by the form regions.

const api = vi.hoisted(() => ({
  peekRecovery: vi.fn(),
  startRecoveryMfa: vi.fn(),
  completeRecovery: vi.fn(),
}))
const gotoMock = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('$lib/api/recovery.js', () => api)
vi.mock('$app/navigation', () => ({ goto: gotoMock }))
vi.mock('$app/state', () => ({ page: { route: { id: null }, params: { token: 'tok-1' } } }))

const POINTS = [
  'auth.recovery-detail.content',
  'auth.recovery-detail.status',
  'auth.recovery-detail.codes',
  'auth.recovery-detail.password',
  'auth.recovery-detail.mfa',
] as const
const [, STATUS, CODES, PASSWORD, MFA] = POINTS
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))
const TYPED_PASSWORD = 'a-very-long-typed-password'
const TYPED_CODE = '123456'
const MANUAL_ENTRY_KEY = 'MANUALKEY123'

let Content: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Content = (await import('./RecoveryResetContent.svelte')).default as unknown as typeof Content
}, 60_000)
beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  gotoMock.mockClear()
})
afterEach(cleanup)

const mount = () => render(Content, { props: { data: fills } })
const probes = (point: string): HTMLElement[] =>
  screen.queryAllByTestId('probe').filter((el) => el.textContent?.includes(`"fill:${point}"`))
const probe = (point: string): HTMLElement => {
  const found = probes(point)[0]
  if (found === undefined) throw new Error(`no probe for ${point}`)
  return found
}
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
const passwordInput = (): HTMLInputElement =>
  document.getElementById('recovery-new-password') as HTMLInputElement
const totpInput = (): HTMLInputElement =>
  document.getElementById('recovery-totp') as HTMLInputElement
const submit = () => fireEvent.submit(passwordInput().closest('form') as HTMLFormElement)
const allProbeText = (): string =>
  screen
    .queryAllByTestId('probe')
    .map((el) => el.textContent ?? '')
    .join('\n')

async function openReady() {
  api.peekRecovery.mockResolvedValueOnce({ email: 'a.b', mfaCurrentlyEnrolled: false })
  mount()
  await screen.findByText('Set a new password')
}
async function enableMfa() {
  api.startRecoveryMfa.mockResolvedValueOnce({
    otpauthUrl: 'otpauth.example',
    secret: MANUAL_ENTRY_KEY,
    qrCodeSvg: '<svg></svg>',
  })
  await fireEvent.click(screen.getByRole('checkbox'))
  await screen.findByText(/Manual entry key/)
}

describe('RecoveryResetContent sub-regions (probe order)', () => {
  it('status: after the checking message while the link is read', () => {
    api.peekRecovery.mockReturnValue(new Promise(() => undefined))
    mount()
    expect(follows(screen.getByText('Checking your recovery link...'), probe(STATUS))).toBe(true)
    expect(probes(PASSWORD)).toHaveLength(0)
    expect(probes(CODES)).toHaveLength(0)
  })

  it.each([
    ['recovery_token_not_found', 'Recovery link not found'],
    ['recovery_token_expired', 'Recovery link expired'],
    ['recovery_token_used', 'Recovery link already used'],
    ['recovery_token_superseded', 'A newer recovery link was requested'],
    ['unexpected', 'Something went wrong'],
  ])('status: after the %s panel and no form is rendered', async (code, heading) => {
    api.peekRecovery.mockRejectedValueOnce(new ApiClientError(404, { code }, 'nope'))
    mount()
    const title = await screen.findByText(heading)
    expect(follows(title, probe(STATUS))).toBe(true)
    expect(document.getElementById('recovery-new-password')).toBeNull()
    expect(probes(MFA)).toHaveLength(0)
  })

  it('password: after the field help, before the length hint', async () => {
    await openReady()
    const password = probe(PASSWORD)
    expect(follows(document.getElementById('recovery-new-password-help') as Node, password)).toBe(
      true
    )
    expect(follows(password, screen.getByText('Use at least 12 characters.'))).toBe(true)
    expect(probes(STATUS)).toHaveLength(0)
  })

  it('mfa: after the toggle help, before the submit button, and after the QR block once opted in', async () => {
    await openReady()
    const mfa = probe(MFA)
    expect(follows(document.getElementById('recovery-mfa-toggle-help') as Node, mfa)).toBe(true)
    expect(follows(mfa, screen.getByRole('button', { name: 'Reset password' }))).toBe(true)
    await enableMfa()
    expect(follows(totpInput(), probe(MFA))).toBe(true)
    expect(follows(probe(PASSWORD), probe(MFA))).toBe(true)
  })

  it('codes: after the Continue button, replacing the form', async () => {
    api.completeRecovery.mockResolvedValueOnce({ recoveryCodes: ['code-one', 'code-two'] })
    await openReady()
    await fireEvent.input(passwordInput(), { target: { value: TYPED_PASSWORD } })
    await submit()
    await screen.findByText('Save your recovery codes')
    expect(follows(screen.getByRole('button', { name: 'Continue to login' }), probe(CODES))).toBe(
      true
    )
    expect(probes(PASSWORD)).toHaveLength(0)
    expect(probes(MFA)).toHaveLength(0)
  })
})

describe('RecoveryResetContent point hygiene', () => {
  it('no typed value, MFA secret or recovery code reaches any point', async () => {
    api.completeRecovery.mockResolvedValueOnce({ recoveryCodes: ['code-one', 'code-two'] })
    await openReady()
    await enableMfa()
    await fireEvent.input(passwordInput(), { target: { value: TYPED_PASSWORD } })
    await fireEvent.input(totpInput(), { target: { value: TYPED_CODE } })
    const beforeSubmit = allProbeText()
    await submit()
    await screen.findByText('Save your recovery codes')
    const afterSubmit = allProbeText()
    for (const text of [beforeSubmit, afterSubmit]) {
      for (const secret of [TYPED_PASSWORD, TYPED_CODE, MANUAL_ENTRY_KEY, 'code-one', 'code-two']) {
        expect(text).not.toContain(secret)
      }
    }
    for (const el of screen.getAllByTestId('probe')) {
      expect(el.getAttribute('data-keys')).toBe('data,params,routeId')
    }
  })
})

describe('RecoveryResetContent state (one owner)', () => {
  it('the typed password survives opening and closing MFA and is the one submitted', async () => {
    api.completeRecovery.mockResolvedValueOnce({})
    await openReady()
    await fireEvent.input(passwordInput(), { target: { value: TYPED_PASSWORD } })
    await enableMfa()
    await fireEvent.click(screen.getByRole('checkbox'))
    expect(passwordInput().value).toBe(TYPED_PASSWORD)
    await submit()
    await waitFor(() => expect(gotoMock).toHaveBeenCalledWith('/login?reason=recovery-complete'))
    expect(api.completeRecovery.mock.calls.map((call) => call.slice(1))).toEqual([
      ['tok-1', { newPassword: TYPED_PASSWORD }],
    ])
  })

  it('an incomplete code blocks the submit in the shell and keeps both regions mounted', async () => {
    await openReady()
    await enableMfa()
    await fireEvent.input(passwordInput(), { target: { value: TYPED_PASSWORD } })
    await fireEvent.input(totpInput(), { target: { value: '12' } })
    await submit()
    const error = await screen.findByText(/Enter the 6-digit code/)
    expect(api.completeRecovery).not.toHaveBeenCalled()
    expect(follows(screen.getByText('Choose a new password for your account.'), error)).toBe(true)
    expect(follows(error, passwordInput())).toBe(true)
    expect(passwordInput().value).toBe(TYPED_PASSWORD)
    expect(totpInput().value).toBe('12')
  })

  it('a code entered in the MFA region is submitted with the password from the password region', async () => {
    api.completeRecovery.mockResolvedValueOnce({ recoveryCodes: ['code-one'] })
    await openReady()
    await enableMfa()
    await fireEvent.input(passwordInput(), { target: { value: TYPED_PASSWORD } })
    await fireEvent.input(totpInput(), { target: { value: TYPED_CODE } })
    await submit()
    await screen.findByText('Save your recovery codes')
    expect(api.completeRecovery.mock.calls.map((call) => call.slice(1))).toEqual([
      ['tok-1', { newPassword: TYPED_PASSWORD, totpCode: TYPED_CODE }],
    ])
    await fireEvent.click(screen.getByRole('button', { name: 'Continue to login' }))
    expect(gotoMock).toHaveBeenCalledWith('/login?reason=recovery-complete')
  })

  it('a failed MFA start reports above the form and keeps the opt-in off', async () => {
    await openReady()
    api.startRecoveryMfa.mockRejectedValueOnce(new Error('nope'))
    await fireEvent.click(screen.getByRole('checkbox'))
    const error = await screen.findByText(/Could not start MFA re-enrollment/)
    expect(follows(error, passwordInput())).toBe(true)
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  })
})
