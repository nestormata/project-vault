import { describe, expect, it } from 'vitest'
import {
  buildLoginRequest,
  buildMfaLoginRequest,
  buildRegisterRequest,
  clearLoginFields,
  clearMfaLoginFields,
  clearRegisterFields,
  getPostRegisterPath,
  isMfaChallenge,
} from '$lib/components/auth/form-model.js'

describe('auth form model', () => {
  it('builds register requests and routes to login after registration', () => {
    const fields = {
      email: 'alex@example.com',
      password: 'twelve-characters',
      orgName: 'Example Org',
    }

    expect(buildRegisterRequest(fields)).toEqual(fields)
    expect(getPostRegisterPath()).toBe('/login?reason=registered')
    expect(clearRegisterFields(fields)).toEqual({ email: '', password: '', orgName: '' })
  })

  it('builds login requests without exposing token-shaped data', () => {
    const fields = { email: 'alex@example.com', password: 'twelve-characters' }

    expect(buildLoginRequest(fields)).toEqual(fields)
    expect(JSON.stringify(buildLoginRequest(fields))).not.toContain('token')
    expect(clearLoginFields(fields)).toEqual({ email: '', password: '' })
  })

  it('detects MFA login challenges and builds transient MFA verification requests', () => {
    const challenge = { mfaRequired: true as const, mfaToken: 'u8Jx2k4mQ1pZr7sV9aBcDe' }
    const fields = { mfaToken: challenge.mfaToken, totp: '123456' }

    expect(isMfaChallenge(challenge)).toBe(true)
    expect(buildMfaLoginRequest(fields)).toEqual(fields)
    expect(clearMfaLoginFields(fields)).toEqual({ mfaToken: '', totp: '' })
  })
})
