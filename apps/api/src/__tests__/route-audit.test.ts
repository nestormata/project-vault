import { describe, it } from 'vitest'

export const EXEMPT_PATHS = new Set([
  '/health',
  '/ready',
  '/metrics',
  '/api/v1/vault/init',
  '/api/v1/vault/unseal',
  '/api/v1/auth/register',
  '/api/v1/auth/login',
  '/api/v1/auth/refresh',
])

describe('route audit', () => {
  it.todo('every /api/v1/ route must be registered via SecureRoute')
})
