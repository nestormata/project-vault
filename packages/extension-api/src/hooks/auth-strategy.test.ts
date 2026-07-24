import { describe, expect, it } from 'vitest'
import type { AuthResult, AuthStrategy } from './auth-strategy.js'

describe('AuthStrategy', () => {
  it('onAuthenticate resolves an AuthResult shaped per architecture.md (externalSubject, providerName, optional email/displayName)', async () => {
    const strategy: AuthStrategy = {
      onAuthenticate: (credential: string) =>
        Promise.resolve({
          externalSubject: `subject-${credential}`,
          providerName: 'fixture-provider',
          email: 'user@example.com',
          displayName: 'Fixture User',
        }),
    }

    const result: AuthResult = await strategy.onAuthenticate('token-123')

    expect(result).toEqual({
      externalSubject: 'subject-token-123',
      providerName: 'fixture-provider',
      email: 'user@example.com',
      displayName: 'Fixture User',
    })
  })

  it('email and displayName are optional', async () => {
    const strategy: AuthStrategy = {
      onAuthenticate: () => Promise.resolve({ externalSubject: 'sub', providerName: 'provider' }),
    }

    await expect(strategy.onAuthenticate('anything')).resolves.toEqual({
      externalSubject: 'sub',
      providerName: 'provider',
    })
  })
})
