import { describe, expect, it, vi, beforeEach } from 'vitest'

const lookupSsoDomainMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/auth.js', () => ({
  lookupSsoDomain: lookupSsoDomainMock,
}))

import { buildRegisterRequest, getPostRegisterPath, resolvePreAuthTheme } from './form-model.js'

describe('buildRegisterRequest', () => {
  it('sends orgName when there is no invitation token', () => {
    expect(
      buildRegisterRequest({ email: 'a@example.com', password: 'x', orgName: 'Acme' })
    ).toEqual({ email: 'a@example.com', password: 'x', orgName: 'Acme' })
  })

  it('sends invitationToken instead of orgName when a token is present (Story 4.1 D4)', () => {
    expect(
      buildRegisterRequest({
        email: 'a@example.com',
        password: 'x',
        orgName: 'Ignored',
        invitationToken: 'opaque-token',
      })
    ).toEqual({ email: 'a@example.com', password: 'x', invitationToken: 'opaque-token' })
  })
})

describe('getPostRegisterPath', () => {
  it('redirects to login by default', () => {
    expect(getPostRegisterPath()).toBe('/login?reason=registered')
  })

  it('redirects into the invited project when registration joined via invitation', () => {
    expect(getPostRegisterPath({ projectId: 'project-123' })).toBe('/projects/project-123')
  })
})

// Story 16.5 Task 0.3: shared fetch-and-normalize-and-fail-open helper reused by RegisterForm and
// invitations/accept/+page.svelte (and, for its normalization shape, LoginForm's own resolver).
describe('resolvePreAuthTheme', () => {
  beforeEach(() => {
    lookupSsoDomainMock.mockReset()
  })

  it('returns the resolved theme name/css on a successful lookup that carries a theme', async () => {
    lookupSsoDomainMock.mockResolvedValue({
      ssoRequired: false,
      theme: { name: 'acme-brand', css: '[data-theme="acme-brand"] {}' },
    })

    await expect(resolvePreAuthTheme(fetch, 'alex@acme.com')).resolves.toEqual({
      name: 'acme-brand',
      css: '[data-theme="acme-brand"] {}',
    })
    expect(lookupSsoDomainMock).toHaveBeenCalledWith(fetch, 'alex@acme.com')
  })

  it('normalizes a miss/no-theme response to { name: null, css: null }', async () => {
    lookupSsoDomainMock.mockResolvedValue({ ssoRequired: false })

    await expect(resolvePreAuthTheme(fetch, 'jordan@startupinc.example')).resolves.toEqual({
      name: null,
      css: null,
    })
  })

  it('falls open to { name: null, css: null } when the lookup call rejects', async () => {
    lookupSsoDomainMock.mockRejectedValue(new TypeError('Failed to fetch'))

    await expect(resolvePreAuthTheme(fetch, 'jordan@acme.com')).resolves.toEqual({
      name: null,
      css: null,
    })
  })
})
