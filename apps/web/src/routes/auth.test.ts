import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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

const routeRoot = resolve(dirname(fileURLToPath(import.meta.url)))
const authComponentsRoot = resolve(routeRoot, '../lib/components/auth')

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

  it('guards login and MFA submissions while a request is already in flight', () => {
    const loginSource = readFileSync(resolve(authComponentsRoot, 'LoginForm.svelte'), 'utf-8')
    const mfaSource = readFileSync(resolve(authComponentsRoot, 'MfaLoginForm.svelte'), 'utf-8')

    expect(loginSource).toContain('if (isSubmitting) return')
    expect(loginSource).toContain('disabled={isSubmitting}')
    expect(mfaSource).toContain('if (isSubmitting) return')
    expect(mfaSource).toContain('disabled={isSubmitting}')
  })
})
