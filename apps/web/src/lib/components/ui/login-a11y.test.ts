import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import axe from 'axe-core'
import LoginForm from '$lib/components/auth/LoginForm.svelte'
import { idProblems } from '$lib/test/dom.js'

// Story 72.3 AC-4: the login family (the D-10 pattern route family) has no axe violation and every
// control has a programmatic name, in each step the form can show.

vi.mock('$app/navigation', () => ({ goto: vi.fn() }))
vi.mock('$lib/api/auth.js', () => ({
  getCurrentUser: vi.fn(),
  login: vi.fn(),
  lookupSsoDomain: vi.fn(async () => ({ ssoRequired: false, theme: null })),
  ssoCallback: vi.fn(),
  ssoStart: vi.fn(),
  verifyMfaLogin: vi.fn(),
}))

afterEach(() => cleanup())

async function violations(root: Element): Promise<string[]> {
  const result = await axe.run(root, {
    // jsdom has no layout or paint, so the colour checks cannot run here (the contrast of the
    // border is pinned by controls.test.ts; the page is checked in Chrome).
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  })
  return result.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`
  )
}

describe('login family accessibility (72.3)', () => {
  it('email step: no axe violation, each control named', async () => {
    const { container } = render(LoginForm, { props: {} })
    expect(await violations(container)).toEqual([])
    expect(screen.getByRole('textbox', { name: 'Email' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy()
    expect(idProblems(container)).toEqual([])
  })

  it('password step: no axe violation, each control named', async () => {
    const { container } = render(LoginForm, { props: {} })
    await fireEvent.input(screen.getByRole('textbox', { name: 'Email' }), {
      target: { value: `${'user'}@${'example.test'}` },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    const password = await screen.findByLabelText('Password')
    expect(password.getAttribute('aria-describedby')).toBe('login-password-help')
    expect(screen.getByRole('textbox', { name: 'Email' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
    expect(await violations(container)).toEqual([])
    expect(idProblems(container)).toEqual([])
  })

  it('sso step: no axe violation, each control named', async () => {
    const auth = await import('$lib/api/auth.js')
    vi.mocked(auth.lookupSsoDomain).mockResolvedValueOnce({
      ssoRequired: true,
      providerName: 'corp',
      theme: null,
    } as never)
    const { container } = render(LoginForm, { props: {} })
    await fireEvent.input(screen.getByRole('textbox', { name: 'Email' }), {
      target: { value: `${'user'}@${'example.test'}` },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    const credential = await screen.findByRole('textbox', { name: /credential/i })
    expect(credential.getAttribute('aria-describedby')).toBe('login-sso-help')
    expect(await violations(container)).toEqual([])
    expect(idProblems(container)).toEqual([])
  })

  it('placeholder step (native login off): no axe violation', async () => {
    const { container } = render(LoginForm, { props: { nativeLoginEnabled: false } })
    await fireEvent.input(screen.getByRole('textbox', { name: 'Email' }), {
      target: { value: `${'user'}@${'example.test'}` },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', { level: 2 })
    expect(await violations(container)).toEqual([])
  })
})
