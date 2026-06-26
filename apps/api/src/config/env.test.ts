import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest'

const VAULT_APP_DATABASE_URL = 'postgresql://vault_app:secret@localhost:5432/project_vault'

const BASE_ENV = {
  NODE_ENV: 'test',
  API_PORT: '3000',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
  METRICS_BIND_HOST: '127.0.0.1',
  LOG_LEVEL: 'fatal',
}

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

  // Order matters: loadEnv() calls a mocked process.exit() (a no-op here) and then
  // falls through to `return result.data`, so a failing import still populates and
  // caches a module with env=undefined. Running the accepting case first, before any
  // module cache pollution from the rejecting case, keeps both cases independently valid.
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
    await import('./env.js')
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
})
