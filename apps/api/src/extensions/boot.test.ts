import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createApp } from '../app.js'
import { __resetExtensionStateForTests, getExtensionStatus } from './loader.js'

/**
 * Task 7: boot-sequence integration test — exercises the REAL loadExtension() (no loader.js
 * mock, unlike routes/health.test.ts, which stubs it out to control extensions_status
 * directly) through the actual createApp() call site, proving a misconfigured
 * VAULT_EXTENSIONS_PACKAGE can never crash/reject createApp() itself.
 */
const { mockExtensionsPackage } = vi.hoisted(() => ({
  mockExtensionsPackage: { value: undefined as string | undefined },
}))

vi.mock('../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    API_PORT: 3000,
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
    METRICS_BIND_HOST: '127.0.0.1',
    LOG_LEVEL: 'silent',
    SERVICE_NAME: 'api',
    TRUST_PROXY: false,
    TRUST_PROXY_HOPS: 1,
    get VAULT_EXTENSIONS_PACKAGE() {
      return mockExtensionsPackage.value
    },
  },
}))

beforeEach(() => {
  __resetExtensionStateForTests()
  mockExtensionsPackage.value = undefined
})

describe('createApp() — Task 7 boot-sequence wiring', () => {
  it('boots successfully with no extension configured (AC-1)', async () => {
    const app = await createApp({ logger: false })
    expect(getExtensionStatus()).toEqual({ status: 'not_configured' })
    await app.close()
  })

  it('a package that fails to resolve does not crash/reject createApp() (AC-3)', async () => {
    mockExtensionsPackage.value = '@project-vault/definitely-not-a-real-extension-package'

    await expect(createApp({ logger: false })).resolves.toBeDefined()
    expect(getExtensionStatus().status).toBe('load_failed')
  }, 15_000)
})
