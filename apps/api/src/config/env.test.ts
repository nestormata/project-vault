import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest'

const VAULT_APP_DATABASE_URL = 'postgresql://vault_app:secret@localhost:5432/project_vault'

const BASE_ENV = {
  NODE_ENV: 'test',
  API_PORT: '3000',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
  METRICS_BIND_HOST: '127.0.0.1',
  LOG_LEVEL: 'fatal',
}

const AUTH_DUMMY_PASSWORD_HASH = '$argon2id$v=19$m=19456,t=2,p=1$salt$hash'

describe('env', () => {
  let originalEnv: NodeJS.ProcessEnv
  let exitSpy: MockInstance<(...args: never[]) => unknown>

  beforeEach(() => {
    originalEnv = process.env
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.resetModules()
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  it('accepts a DATABASE_URL using a non-superuser role', async () => {
    process.env = {
      ...BASE_ENV,
      DATABASE_URL: VAULT_APP_DATABASE_URL,
    }
    const { env } = await import('./env.js')
    expect(env.DATABASE_URL).toBe(VAULT_APP_DATABASE_URL)
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('rejects a DATABASE_URL using the postgres superuser', async () => {
    process.env = {
      ...BASE_ENV,
      DATABASE_URL: 'postgresql://postgres:password@localhost:5432/project_vault',
    }
    await expect(import('./env.js')).rejects.toThrow(/Invalid environment/)
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('defaults VAULT_KEY_DIR to /run/secrets and VAULT_ALLOW_REMOTE_INIT to false when unset', async () => {
    process.env = {
      ...BASE_ENV,
      DATABASE_URL: VAULT_APP_DATABASE_URL,
    }
    const { env } = await import('./env.js')
    expect(env.VAULT_KEY_DIR).toBe('/run/secrets')
    expect(env.VAULT_ALLOW_REMOTE_INIT).toBe(false)
  })

  it('defaults auth environment settings for local/test startup', async () => {
    process.env = {
      ...BASE_ENV,
      DATABASE_URL: VAULT_APP_DATABASE_URL,
    }
    const { env } = await import('./env.js')
    expect(env.SESSION_SECRET).toHaveLength(64)
    expect(env.REFRESH_TOKEN_HMAC_SECRET).toHaveLength(64)
    expect(env.SESSION_SECRET).not.toBe(env.REFRESH_TOKEN_HMAC_SECRET)
    expect(env.JWT_ACCESS_TTL_SECONDS).toBe(300)
    expect(env.REFRESH_TOKEN_TTL_DAYS).toBe(7)
    expect(env.REFRESH_GRACE_WINDOW_SECONDS).toBe(30)
    expect(env.ARGON2_MEMORY_COST).toBe(65536)
    expect(env.ARGON2_TIME_COST).toBe(3)
    expect(env.ARGON2_PARALLELISM).toBe(4)
    expect(env.AUTH_REGISTRATION_ENABLED).toBe(true)
    expect(env.COOKIE_SECURE).toBe(false)
    expect(env.TRUST_PROXY).toBe(false)
    expect(env.TRUST_PROXY_HOPS).toBe(1)
  })

  it('rejects identical auth secrets', async () => {
    process.env = {
      ...BASE_ENV,
      DATABASE_URL: VAULT_APP_DATABASE_URL,
      SESSION_SECRET: 'a'.repeat(64),
      REFRESH_TOKEN_HMAC_SECRET: 'a'.repeat(64),
    }
    await expect(import('./env.js')).rejects.toThrow(/Invalid environment/)
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('rejects an invalid dummy password hash', async () => {
    process.env = {
      ...BASE_ENV,
      DATABASE_URL: VAULT_APP_DATABASE_URL,
      AUTH_DUMMY_PASSWORD_HASH: 'not-a-phc-hash',
    }
    await expect(import('./env.js')).rejects.toThrow(/Invalid environment/)
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('rejects Argon2 memory cost above the safety cap', async () => {
    process.env = {
      ...BASE_ENV,
      DATABASE_URL: VAULT_APP_DATABASE_URL,
      ARGON2_MEMORY_COST: '262145',
    }
    await expect(import('./env.js')).rejects.toThrow(/Invalid environment/)
    expect(exitSpy).toHaveBeenCalledWith(1)
  })

  it('defaults COOKIE_SECURE to true in production and rejects placeholder secrets', async () => {
    process.env = {
      ...BASE_ENV,
      NODE_ENV: 'production',
      DATABASE_URL: VAULT_APP_DATABASE_URL,
      SESSION_SECRET: 'change-me'.repeat(8),
      REFRESH_TOKEN_HMAC_SECRET: 'b'.repeat(64),
      AUTH_DUMMY_PASSWORD_HASH,
    }
    await expect(import('./env.js')).rejects.toThrow(/Invalid environment/)
    expect(exitSpy).toHaveBeenCalledWith(1)

    vi.resetModules()
    exitSpy.mockClear()
    process.env = {
      ...BASE_ENV,
      NODE_ENV: 'production',
      DATABASE_URL: VAULT_APP_DATABASE_URL,
      SESSION_SECRET: 'a'.repeat(64),
      REFRESH_TOKEN_HMAC_SECRET: 'b'.repeat(64),
      AUTH_DUMMY_PASSWORD_HASH,
    }
    const { env } = await import('./env.js')
    expect(env.COOKIE_SECURE).toBe(true)
    expect(exitSpy).not.toHaveBeenCalled()
  })
})
