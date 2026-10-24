import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'

// Story 69.11: the sign-in handoff page body is one sub-region per state of the confirmation. A probe
// lands after its own state's section, only the sub-region of the rendered state is present, and the
// flow keeps ONE owner of the state machine across confirm, MFA and rejection.

const api = vi.hoisted(() => ({
  confirmHandoff: vi.fn(),
  getCurrentUser: vi.fn(),
  verifyMfaLogin: vi.fn(),
  goto: vi.fn(async () => undefined),
  page: { url: new URL('http://localhost/handoff') },
}))
vi.mock('$app/state', () => ({ page: api.page }))
vi.mock('$app/navigation', () => ({ goto: api.goto }))
vi.mock('$lib/api/auth.js', () => ({
  confirmHandoff: api.confirmHandoff,
  getCurrentUser: api.getCurrentUser,
  verifyMfaLogin: api.verifyMfaLogin,
}))

const POINTS = ['auth.handoff.error', 'auth.handoff.mfa', 'auth.handoff.confirm'] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))
const GENERIC = 'Sign-in could not be verified. Please start again.'

let Content: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Content = (await import('./HandoffConfirmContent.svelte')).default as unknown as typeof Content
}, 60_000)
beforeEach(() => {
  document.cookie = 'PARAGLIDE_LOCALE=en; path=/'
  api.page.url = new URL('http://localhost/handoff?pendingId=abc123_XYZ-789&organizationName=Acme')
  for (const fn of [api.confirmHandoff, api.getCurrentUser, api.verifyMfaLogin, api.goto]) {
    fn.mockReset()
  }
})
afterEach(cleanup)

const mount = (centralizeMeOrigin: string | null = 'https://cm.example.com') =>
  render(Content, { props: { centralizeMeOrigin, data: fills } })
const probe = (point: string): HTMLElement => {
  const found = screen
    .getAllByTestId('probe')
    .find((el) => el.textContent?.includes(`"fill:${point}"`))
  if (found === undefined) throw new Error(`no probe for ${point}`)
  return found
}
const probeCount = () => screen.queryAllByTestId('probe').length
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
const confirm = () => fireEvent.click(screen.getByRole('button', { name: 'Confirm sign-in' }))

describe('HandoffConfirmContent sub-regions (probe order)', () => {
  it('confirm: after the Not me link, and no other sub-region', () => {
    mount()
    expect(
      follows(screen.getByRole('link', { name: /not me|cancel/i }), probe('auth.handoff.confirm'))
    ).toBe(true)
    expect(probeCount()).toBe(1)
  })

  it('error: after the return guidance for a missing or malformed pending sign-in', () => {
    api.page.url = new URL('http://localhost/handoff')
    mount()
    expect(screen.getByRole('alert').textContent?.trim()).toBe(GENERIC)
    expect(
      follows(screen.getByRole('link', { name: /CentralizeMe/ }), probe('auth.handoff.error'))
    ).toBe(true)
    expect(probeCount()).toBe(1)
    expect(screen.queryByRole('button', { name: 'Confirm sign-in' })).toBeNull()
  })

  it('error: still after the guidance text when no CentralizeMe origin is configured', () => {
    api.page.url = new URL('http://localhost/handoff?pendingId=bad%20id')
    mount(null)
    expect(screen.queryByRole('link', { name: /CentralizeMe/ })).toBeNull()
    expect(follows(screen.getByText(/CentralizeMe/), probe('auth.handoff.error'))).toBe(true)
  })

  it('mfa: after the MFA form once the confirm asks for a second factor', async () => {
    api.confirmHandoff.mockResolvedValue({ mfaRequired: true, mfaToken: 'mfa-tok-1' })
    mount()
    await confirm()
    const code = await screen.findByLabelText(/authenticator code/i)
    expect(follows(code, probe('auth.handoff.mfa'))).toBe(true)
    expect(probeCount()).toBe(1)
    for (const el of screen.getAllByTestId('probe')) {
      expect(el.textContent).not.toContain('mfa-tok-1')
    }
  })
})

describe('HandoffConfirmContent state machine (interaction)', () => {
  it('a 401 moves to the error sub-region with the generic copy and no retry', async () => {
    api.confirmHandoff.mockRejectedValue(new ApiClientError(401, { code: 'x' }, 'raw server text'))
    mount()
    await confirm()
    expect((await screen.findByRole('alert')).textContent?.trim()).toBe(GENERIC)
    expect(screen.queryByRole('button', { name: 'Confirm sign-in' })).toBeNull()
    expect(probe('auth.handoff.error')).toBeTruthy()
    expect(probeCount()).toBe(1)
  })

  it('a 503 shows the login-failed copy in the same error sub-region', async () => {
    api.confirmHandoff.mockRejectedValue(new ApiClientError(503, null, 'down'))
    mount()
    await confirm()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent?.trim()).not.toBe(GENERIC)
    expect(probe('auth.handoff.error')).toBeTruthy()
  })

  it('a network failure stays on the confirm prompt with the error above the buttons', async () => {
    api.confirmHandoff.mockRejectedValue(new TypeError('offline'))
    mount()
    await confirm()
    const alert = await screen.findByRole('alert')
    expect(follows(alert, screen.getByRole('button', { name: 'Confirm sign-in' }))).toBe(true)
    expect(probe('auth.handoff.confirm')).toBeTruthy()
  })

  it('completes the session and goes to the dashboard on success', async () => {
    api.confirmHandoff.mockResolvedValue({ userId: 'u1' })
    api.getCurrentUser.mockResolvedValue({ userId: 'u1' })
    mount()
    await confirm()
    await vi.waitFor(() => expect(api.goto).toHaveBeenCalledWith('/dashboard'))
  })

  it('keeps Confirm disabled while a confirm is in flight', async () => {
    let finish: (value: unknown) => void = () => undefined
    api.confirmHandoff.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    api.getCurrentUser.mockResolvedValue({})
    mount()
    await confirm()
    const busy = screen.getByRole('button', { name: /confirming/i }) as HTMLButtonElement
    expect(busy.disabled).toBe(true)
    finish({ userId: 'u1' })
  })
})
