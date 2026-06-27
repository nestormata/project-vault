import { beforeEach, describe, expect, it, vi } from 'vitest'

const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://vault_app:secret@localhost:5432/project_vault',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
  LOG_LEVEL: 'fatal',
}

describe('computeRevokedTokenExpiresAt', () => {
  beforeEach(() => {
    process.env = { ...process.env, ...BASE_ENV }
    vi.resetModules()
  })

  it('uses the access token exp when available', async () => {
    const { computeRevokedTokenExpiresAt } = await import('./session-revoke.js')
    const accessTokenExp = new Date('2026-06-26T10:05:00.000Z')

    expect(
      computeRevokedTokenExpiresAt({
        accessTokenExp,
        refreshTokenExpiresAt: new Date('2026-06-30T10:00:00.000Z'),
        now: new Date('2026-06-26T10:00:00.000Z'),
      })
    ).toEqual(accessTokenExp)
  })

  it('falls back to the smaller of access ttl and refresh expiry', async () => {
    const { computeRevokedTokenExpiresAt } = await import('./session-revoke.js')

    expect(
      computeRevokedTokenExpiresAt({
        refreshTokenExpiresAt: new Date('2026-06-26T10:03:00.000Z'),
        now: new Date('2026-06-26T10:00:00.000Z'),
      })
    ).toEqual(new Date('2026-06-26T10:03:00.000Z'))
  })
})
