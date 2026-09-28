import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte'
import { ApiClientError } from '$lib/api/client.js'

const confirmHandoffMock = vi.hoisted(() => vi.fn())
const getCurrentUserMock = vi.hoisted(() => vi.fn())
const verifyMfaLoginMock = vi.hoisted(() => vi.fn())
const gotoMock = vi.hoisted(() => vi.fn(async () => {}))
const pageMock = vi.hoisted(() => ({ url: new URL('http://localhost/handoff') }))

vi.mock('$lib/api/auth.js', () => ({
  confirmHandoff: confirmHandoffMock,
  getCurrentUser: getCurrentUserMock,
  verifyMfaLogin: verifyMfaLoginMock,
}))

vi.mock('$app/navigation', () => ({
  goto: gotoMock,
}))

vi.mock('$app/state', () => ({
  page: pageMock,
}))

import HandoffPage from './+page.svelte'

const VALID_PENDING_ID = 'abc123_XYZ-789'

function setUrl(query: string) {
  pageMock.url = new URL(`http://localhost/handoff${query}`)
}

function fullQuery({
  pendingId = VALID_PENDING_ID,
  organizationName = 'Acme%20Corp',
  accountLabel = 'alex%40acme.com',
}: {
  pendingId?: string | null
  organizationName?: string | null
  accountLabel?: string | null
} = {}) {
  const parts: string[] = []
  if (pendingId !== null) parts.push(`pendingId=${pendingId}`)
  if (organizationName !== null) parts.push(`organizationName=${organizationName}`)
  if (accountLabel !== null) parts.push(`accountLabel=${accountLabel}`)
  return `?${parts.join('&')}`
}

describe('/handoff +page.svelte', () => {
  beforeEach(() => {
    document.cookie = 'PARAGLIDE_LOCALE=en; path=/'
    setUrl(fullQuery())
    confirmHandoffMock.mockReset()
    getCurrentUserMock.mockReset()
    verifyMfaLoginMock.mockReset()
    gotoMock.mockClear()
  })
  afterEach(() => cleanup())

  // AC1.1
  it('renders the resolved account/org and a Confirm button, with no backend call before clicking', () => {
    render(HandoffPage)

    expect(screen.getByText('Sign in to Project Vault as alex@acme.com in Acme Corp?')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Confirm sign-in' })).toBeTruthy()
    expect(confirmHandoffMock).not.toHaveBeenCalled()
  })

  // AC1.2
  it('renders the neutral error state with no Confirm button when pendingId is missing', () => {
    setUrl(fullQuery({ pendingId: null }))
    render(HandoffPage)

    expect(screen.getByText('Sign-in could not be verified. Please start again.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Confirm sign-in' })).toBeNull()
  })

  it('renders the neutral error state when pendingId is malformed', () => {
    setUrl(fullQuery({ pendingId: 'has a space' }))
    render(HandoffPage)

    expect(screen.getByText('Sign-in could not be verified. Please start again.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Confirm sign-in' })).toBeNull()
  })

  it('renders the neutral error state when pendingId is an empty string', () => {
    setUrl(fullQuery({ pendingId: '' }))
    render(HandoffPage)

    expect(screen.getByText('Sign-in could not be verified. Please start again.')).toBeTruthy()
  })

  // AC1.3
  it('renders HTML-significant characters in org/account names as literal, inert text', () => {
    setUrl(
      fullQuery({
        organizationName: encodeURIComponent('"><script>alert(1)</script>'),
        accountLabel: encodeURIComponent('<b>alex</b>'),
      })
    )
    render(HandoffPage)

    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('b')).toBeNull()
    expect(
      screen.getByText(
        (_, node) =>
          node?.textContent ===
          'Sign in to Project Vault as <b>alex</b> in "><script>alert(1)</script>?'
      )
    ).toBeTruthy()
  })

  // AC1.4
  it('renders the neutral error state on a direct navigation with no query params at all', () => {
    setUrl('')
    render(HandoffPage)

    expect(screen.getByText('Sign-in could not be verified. Please start again.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Confirm sign-in' })).toBeNull()
  })

  // AC1.5
  it('falls back to a generic phrase instead of the literal string "null"', () => {
    setUrl(fullQuery({ organizationName: 'null', accountLabel: 'null' }))
    render(HandoffPage)

    expect(
      screen.getByText('Sign in to Project Vault as your account in your organization?')
    ).toBeTruthy()
    expect(screen.queryByText(/null/)).toBeNull()
  })

  it('falls back to a generic phrase when org/account names are absent but pendingId is valid', () => {
    setUrl(fullQuery({ organizationName: null, accountLabel: null }))
    render(HandoffPage)

    expect(
      screen.getByText('Sign in to Project Vault as your account in your organization?')
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Confirm sign-in' })).toBeTruthy()
  })

  // AC2.5
  it('completes the session and navigates to /dashboard on immediate success', async () => {
    confirmHandoffMock.mockResolvedValue({
      userId: 'u1',
      orgId: 'o1',
      expiresAt: '2026-01-01T00:00:00Z',
    })
    getCurrentUserMock.mockResolvedValue({ userId: 'u1' })

    render(HandoffPage)
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm sign-in' }))

    await waitFor(() => expect(gotoMock).toHaveBeenCalledWith('/dashboard'))
    expect(getCurrentUserMock).toHaveBeenCalled()
  })

  // AC2.6
  it('renders MfaLoginForm unmodified when a 200 mfaRequired response is returned', async () => {
    confirmHandoffMock.mockResolvedValue({ mfaRequired: true, mfaToken: 'mfa-tok-1' })

    render(HandoffPage)
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm sign-in' }))

    expect(await screen.findByLabelText(/authenticator code/i)).toBeTruthy()

    verifyMfaLoginMock.mockResolvedValue({
      userId: 'u1',
      orgId: 'o1',
      expiresAt: '2026-01-01T00:00:00Z',
    })
    getCurrentUserMock.mockResolvedValue({ userId: 'u1' })
    await fireEvent.input(screen.getByLabelText(/authenticator code/i), {
      target: { value: '123456' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /verify mfa code/i }))

    await waitFor(() => expect(gotoMock).toHaveBeenCalledWith('/dashboard'))
  })

  // AC2.7
  it('renders the generic rejection message with no retry button on a 401', async () => {
    confirmHandoffMock.mockRejectedValue(
      new ApiClientError(
        401,
        { code: 'handoff_rejected', message: 'Sign-in could not be verified. Please start again.' },
        'Sign-in could not be verified. Please start again.'
      )
    )

    render(HandoffPage)
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm sign-in' }))

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Sign-in could not be verified. Please start again.'
    )
    expect(screen.queryByRole('button', { name: 'Confirm sign-in' })).toBeNull()
    expect(screen.getByText(/return to centralizeme/i)).toBeTruthy()
  })

  it('shows the shared generic-rejection copy even if the 401 body carries a different message', async () => {
    confirmHandoffMock.mockRejectedValue(
      new ApiClientError(401, { message: 'something else' }, 'something else')
    )

    render(HandoffPage)
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm sign-in' }))

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Sign-in could not be verified. Please start again.'
    )
  })

  // AC2.8
  it('renders a distinct message on a 503 login_failed response', async () => {
    confirmHandoffMock.mockRejectedValue(
      new ApiClientError(503, { code: 'login_failed' }, 'Login failed, please try again')
    )

    render(HandoffPage)
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm sign-in' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).not.toBe('Sign-in could not be verified. Please start again.')
    expect(screen.queryByRole('button', { name: 'Confirm sign-in' })).toBeNull()
  })

  // AC2.9
  it('ignores a second click while a confirm request is already in flight', async () => {
    let resolveConfirm: (value: unknown) => void = () => {}
    confirmHandoffMock.mockReturnValue(
      new Promise((resolve) => {
        resolveConfirm = resolve
      })
    )

    render(HandoffPage)
    const button = screen.getByRole('button', { name: 'Confirm sign-in' })
    await fireEvent.click(button)
    await fireEvent.click(button)

    expect(confirmHandoffMock).toHaveBeenCalledTimes(1)
    resolveConfirm({ userId: 'u1', orgId: 'o1', expiresAt: '2026-01-01T00:00:00Z' })
    getCurrentUserMock.mockResolvedValue({ userId: 'u1' })
    await waitFor(() => expect(gotoMock).toHaveBeenCalled())
  })

  // AC2.10
  it('shows a network-error state distinct from 401/503 and re-enables the Confirm button', async () => {
    confirmHandoffMock.mockRejectedValue(new TypeError('Failed to fetch'))

    render(HandoffPage)
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm sign-in' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Something went wrong. Please try again.')
    const retryButton = screen.getByRole('button', { name: 'Confirm sign-in' }) as HTMLButtonElement
    expect(retryButton.disabled).toBe(false)
  })

  // AC5.18
  it('rejects generically for a valid-shaped but cookie-less confirm attempt (no session minted)', async () => {
    confirmHandoffMock.mockRejectedValue(
      new ApiClientError(
        401,
        { code: 'handoff_rejected', message: 'Sign-in could not be verified. Please start again.' },
        'x'
      )
    )

    render(HandoffPage)
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm sign-in' }))

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Sign-in could not be verified. Please start again.'
    )
    expect(gotoMock).not.toHaveBeenCalled()
  })

  // AC5.19
  it('never reads a next/returnTo query parameter', async () => {
    setUrl(`${fullQuery()}&next=/some-other-page`)
    confirmHandoffMock.mockResolvedValue({
      userId: 'u1',
      orgId: 'o1',
      expiresAt: '2026-01-01T00:00:00Z',
    })
    getCurrentUserMock.mockResolvedValue({ userId: 'u1' })

    render(HandoffPage)
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm sign-in' }))

    await waitFor(() => expect(gotoMock).toHaveBeenCalledWith('/dashboard'))
  })

  // ---------------------------------------------------------------------------------------------
  // Story 60.4 (F10/F11)
  // ---------------------------------------------------------------------------------------------

  const ERROR_HEADING = "Sign-in couldn't be completed"
  const CONFIRM_HEADING = 'Confirm sign-in'
  const GUIDANCE_EN = 'Return to CentralizeMe and start signing in again.'
  const GUIDANCE_ES = 'Vuelve a CentralizeMe y empieza a iniciar sesión de nuevo.'
  const CM_ORIGIN = 'https://app.centralizeme.com'
  const SYNTHETIC = 'service-provisioned%2Bab12%40invalid.projectvault'

  function heading(): string | null {
    return screen.getByRole('heading', { level: 1 }).textContent
  }

  function guidanceParagraph(): HTMLElement {
    return screen.getByText((_, node) => node?.tagName === 'P' && node.textContent === GUIDANCE_EN)
  }

  function rejectWith(status: number) {
    confirmHandoffMock.mockRejectedValue(
      new ApiClientError(status, { code: 'handoff_rejected' }, 'Sign-in could not be verified.')
    )
  }

  async function clickConfirm() {
    await fireEvent.click(screen.getByRole('button', { name: CONFIRM_HEADING }))
  }

  describe('AC1 (web half): synthetic service-provisioned label never renders', () => {
    it('1.9: a synthetic accountLabel query param falls back to "your account"', () => {
      setUrl(fullQuery({ accountLabel: SYNTHETIC }))
      render(HandoffPage)

      expect(
        screen.getByText('Sign in to Project Vault as your account in Acme Corp?')
      ).toBeTruthy()
      expect(document.body.textContent).not.toContain('invalid.projectvault')
    })

    it('1.9: a whitespace-padded synthetic label also falls back', () => {
      setUrl(fullQuery({ accountLabel: encodeURIComponent(`  ${decodeURIComponent(SYNTHETIC)} `) }))
      render(HandoffPage)

      expect(document.body.textContent).not.toContain('invalid.projectvault')
    })

    it('1.9: a case-variant synthetic label also falls back', () => {
      setUrl(
        fullQuery({
          accountLabel: encodeURIComponent('Service-Provisioned+X@INVALID.PROJECTVAULT'),
        })
      )
      render(HandoffPage)

      expect(
        screen.getByText('Sign in to Project Vault as your account in Acme Corp?')
      ).toBeTruthy()
    })

    it('1.3: a real email label is still shown verbatim', () => {
      render(HandoffPage)
      expect(
        screen.getByText('Sign in to Project Vault as alex@acme.com in Acme Corp?')
      ).toBeTruthy()
    })

    it.each([
      ['empty', ''],
      ['literal null', 'null'],
      ['absent', null],
    ])('1.10: existing fallbacks still hold (%s)', (_label, accountLabel) => {
      setUrl(fullQuery({ accountLabel }))
      render(HandoffPage)
      expect(
        screen.getByText('Sign in to Project Vault as your account in Acme Corp?')
      ).toBeTruthy()
    })
  })

  describe('AC2: error states use an error heading', () => {
    it.each([
      ['2.1 no query', ''],
      ['2.2 malformed pendingId', '?pendingId=bad%20id!'],
      ['2.3 empty pendingId', '?pendingId='],
    ])('%s → error heading, generic alert, guidance, no Confirm', (_label, query) => {
      setUrl(query)
      render(HandoffPage)

      expect(heading()).toBe(ERROR_HEADING)
      expect(screen.getByRole('alert').textContent?.trim()).toBe(
        'Sign-in could not be verified. Please start again.'
      )
      expect(guidanceParagraph()).toBeTruthy()
      expect(screen.queryByRole('button', { name: CONFIRM_HEADING })).toBeNull()
    })

    it('2.4: Confirm → 401 → error heading, generic alert, guidance', async () => {
      rejectWith(401)
      render(HandoffPage)
      await clickConfirm()

      await screen.findByRole('alert')
      expect(heading()).toBe(ERROR_HEADING)
      expect(guidanceParagraph()).toBeTruthy()
    })

    it('2.5: Confirm → 503 → error heading, login-failed alert, guidance', async () => {
      rejectWith(503)
      render(HandoffPage)
      await clickConfirm()

      const alert = await screen.findByRole('alert')
      expect(alert.textContent?.trim()).toBe('Login failed, please try again.')
      expect(heading()).toBe(ERROR_HEADING)
      expect(guidanceParagraph()).toBeTruthy()
    })

    it('2.6: Confirm → MFA → MFA token expired → error heading, mfa-expired alert', async () => {
      confirmHandoffMock.mockResolvedValue({ mfaRequired: true, mfaToken: 'mfa-tok-1' })
      verifyMfaLoginMock.mockRejectedValue(
        new ApiClientError(401, { code: 'mfa_token_expired' }, 'expired')
      )
      render(HandoffPage)
      await clickConfirm()

      await fireEvent.input(await screen.findByLabelText(/authenticator code/i), {
        target: { value: '123456' },
      })
      await fireEvent.click(screen.getByRole('button', { name: /verify mfa code/i }))

      await waitFor(() => expect(heading()).toBe(ERROR_HEADING))
      expect(screen.getByRole('alert').textContent?.trim()).toBe(
        'Your login step expired. Please sign in again.'
      )
      expect(guidanceParagraph()).toBeTruthy()
    })

    it('2.7: Confirm → fetch throws → heading stays "Confirm sign-in", button enabled', async () => {
      confirmHandoffMock.mockRejectedValue(new TypeError('Failed to fetch'))
      render(HandoffPage)
      await clickConfirm()

      await screen.findByRole('alert')
      expect(heading()).toBe(CONFIRM_HEADING)
      expect(
        (screen.getByRole('button', { name: CONFIRM_HEADING }) as HTMLButtonElement).disabled
      ).toBe(false)
    })

    it('2.8: Confirm → MFA challenge → heading stays "Confirm sign-in"', async () => {
      confirmHandoffMock.mockResolvedValue({ mfaRequired: true, mfaToken: 'mfa-tok-1' })
      render(HandoffPage)
      await clickConfirm()

      await screen.findByLabelText(/authenticator code/i)
      expect(heading()).toBe(CONFIRM_HEADING)
    })

    it('the ready state keeps "Confirm sign-in"', () => {
      render(HandoffPage)
      expect(heading()).toBe(CONFIRM_HEADING)
    })
  })

  describe('AC3: guidance back to CentralizeMe', () => {
    it('3.4: with no configured origin (no data prop) the guidance is plain text, no link', () => {
      setUrl('')
      render(HandoffPage)

      expect(guidanceParagraph().querySelector('a')).toBeNull()
      expect(screen.queryByRole('link', { name: 'Return to CentralizeMe' })).toBeNull()
    })

    it('3.4: an explicit null origin is plain text too', () => {
      setUrl('')
      render(HandoffPage, { props: { data: { centralizeMeOrigin: null } } })
      expect(guidanceParagraph().querySelector('a')).toBeNull()
    })

    it('3.1/3.9: no-params state with a configured origin renders a linked, Referer-safe guidance', () => {
      setUrl('')
      render(HandoffPage, { props: { data: { centralizeMeOrigin: CM_ORIGIN } } })

      expect(heading()).toBe(ERROR_HEADING)
      const link = screen.getByRole('link', { name: 'Return to CentralizeMe' })
      expect(link.getAttribute('href')).toBe(CM_ORIGIN)
      expect(link.getAttribute('rel')?.split(' ')).toEqual(
        expect.arrayContaining(['noopener', 'noreferrer'])
      )
      expect(link.getAttribute('target')).toBeNull()
      // Same copy source as the plain-text branch: the rendered sentence is identical.
      expect(guidanceParagraph()).toBeTruthy()
      // Follow-up help, not part of the announced alert.
      expect(screen.getByRole('alert').contains(link)).toBe(false)
    })

    it('3.10: login_failed with a configured origin renders the linked guidance', async () => {
      rejectWith(503)
      render(HandoffPage, { props: { data: { centralizeMeOrigin: CM_ORIGIN } } })
      await clickConfirm()

      await screen.findByRole('alert')
      expect(heading()).toBe(ERROR_HEADING)
      expect(
        screen.getByRole('link', { name: 'Return to CentralizeMe' }).getAttribute('href')
      ).toBe(CM_ORIGIN)
    })

    it('rejected (401) with a configured origin renders the linked guidance, never a retry', async () => {
      rejectWith(401)
      render(HandoffPage, { props: { data: { centralizeMeOrigin: CM_ORIGIN } } })
      await clickConfirm()

      await screen.findByRole('alert')
      expect(screen.getByRole('link', { name: 'Return to CentralizeMe' })).toBeTruthy()
      expect(screen.queryByRole('button')).toBeNull()
    })

    it('3.8: a returnTo query param never becomes an href', () => {
      setUrl('?returnTo=https%3A%2F%2Fevil.example&cmOrigin=https%3A%2F%2Fevil.example')
      render(HandoffPage)

      expect(document.body.innerHTML).not.toContain('evil.example')
      expect(guidanceParagraph().querySelector('a')).toBeNull()
    })

    it('the guidance is not shown in the ready state', () => {
      render(HandoffPage, { props: { data: { centralizeMeOrigin: CM_ORIGIN } } })
      expect(screen.queryByText(/return to centralizeme/i)).toBeNull()
    })
  })

  describe('AC4: "Not me" exit on the consent screen', () => {
    it('4.1: ready state shows Confirm then a "Not me" link to /login, with no API call', () => {
      render(HandoffPage)

      const confirm = screen.getByRole('button', { name: CONFIRM_HEADING })
      const notMe = screen.getByRole('link', { name: 'Not me' })
      expect(notMe.getAttribute('href')).toBe('/login')
      expect(notMe.getAttribute('aria-disabled')).toBeNull()
      // 4.5: DOM (and therefore Tab) order is Confirm → Not me, in one wrapping row.
      expect(confirm.compareDocumentPosition(notMe) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(confirm.parentElement).toBe(notMe.parentElement)
      expect(confirm.parentElement?.className).toContain('flex-wrap')
      expect(confirmHandoffMock).not.toHaveBeenCalled()
    })

    it('4.2: network_error shows both Confirm (enabled) and "Not me"', async () => {
      confirmHandoffMock.mockRejectedValue(new TypeError('Failed to fetch'))
      render(HandoffPage)
      await clickConfirm()

      await screen.findByRole('alert')
      expect(screen.getByRole('link', { name: 'Not me' })).toBeTruthy()
      expect(
        (screen.getByRole('button', { name: CONFIRM_HEADING }) as HTMLButtonElement).disabled
      ).toBe(false)
    })

    it('4.3: while submitting, "Not me" is inert', async () => {
      confirmHandoffMock.mockReturnValue(new Promise(() => {}))
      render(HandoffPage)
      await clickConfirm()

      const notMe = await screen.findByRole('link', { name: 'Not me' })
      expect(notMe.getAttribute('aria-disabled')).toBe('true')
      expect(notMe.getAttribute('tabindex')).toBe('-1')
      expect(notMe.className).toContain('pointer-events-none')
    })

    it('4.3: while submitting, activating "Not me" (e.g. via assistive tech) does not navigate', async () => {
      confirmHandoffMock.mockReturnValue(new Promise(() => {}))
      render(HandoffPage)
      await clickConfirm()

      const notMe = await screen.findByRole('link', { name: 'Not me' })
      const click = new MouseEvent('click', { bubbles: true, cancelable: true })
      notMe.dispatchEvent(click)
      expect(click.defaultPrevented).toBe(true)
    })

    it.each([
      ['no-params', ''],
      ['malformed', '?pendingId=bad%20id!'],
    ])('4.4: no "Not me" in the %s state', (_label, query) => {
      setUrl(query)
      render(HandoffPage)
      expect(screen.queryByRole('link', { name: 'Not me' })).toBeNull()
    })

    it.each([
      ['rejected', 401],
      ['login_failed', 503],
    ])('4.4: no "Not me" in the %s state', async (_label, status) => {
      rejectWith(status)
      render(HandoffPage)
      await clickConfirm()
      await screen.findByRole('alert')
      expect(screen.queryByRole('link', { name: 'Not me' })).toBeNull()
    })

    it('4.4: no "Not me" in the mfa state', async () => {
      confirmHandoffMock.mockResolvedValue({ mfaRequired: true, mfaToken: 'mfa-tok-1' })
      render(HandoffPage)
      await clickConfirm()
      await screen.findByLabelText(/authenticator code/i)
      expect(screen.queryByRole('link', { name: 'Not me' })).toBeNull()
    })
  })

  describe('es locale', () => {
    beforeEach(() => {
      document.cookie = 'PARAGLIDE_LOCALE=es; path=/'
    })
    afterEach(() => {
      document.cookie = 'PARAGLIDE_LOCALE=en; path=/'
    })

    it('2.9: no-params renders the Spanish error heading and plain guidance', () => {
      setUrl('')
      render(HandoffPage)

      expect(heading()).toBe('No se pudo completar el inicio de sesión')
      expect(
        screen.getByText((_, node) => node?.tagName === 'P' && node.textContent === GUIDANCE_ES)
      ).toBeTruthy()
    })

    it('3.11: linked guidance in Spanish', () => {
      setUrl('')
      render(HandoffPage, { props: { data: { centralizeMeOrigin: CM_ORIGIN } } })

      expect(screen.getByRole('link', { name: 'Vuelve a CentralizeMe' }).getAttribute('href')).toBe(
        CM_ORIGIN
      )
      expect(
        screen.getByText((_, node) => node?.tagName === 'P' && node.textContent === GUIDANCE_ES)
      ).toBeTruthy()
    })

    it('1.11/4.6: synthetic label falls back to "tu cuenta" and the exit reads "No soy yo"', () => {
      setUrl(fullQuery({ accountLabel: SYNTHETIC }))
      render(HandoffPage)

      expect(
        screen.getByText('¿Iniciar sesión en Project Vault como tu cuenta en Acme Corp?')
      ).toBeTruthy()
      expect(screen.getByRole('link', { name: 'No soy yo' }).getAttribute('href')).toBe('/login')
    })
  })
})
