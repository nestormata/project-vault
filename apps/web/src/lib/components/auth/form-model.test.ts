import { describe, expect, it } from 'vitest'
import { buildRegisterRequest, getPostRegisterPath } from './form-model.js'

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
