import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { OperationalEvent } from '@project-vault/shared'
import { createApp } from '../app.js'
import { createLoggerConfig } from '../lib/logger.js'
import { createLogCaptureStream } from '../__tests__/helpers/capture-logs.js'

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
  },
}))

// These tests exercise the DB-connectivity branch of /ready, which only runs once the
// vault is unsealed (Story 1.5) — mock vault status so the DB branch is reachable.
const { mockVaultStatus } = vi.hoisted(() => ({
  mockVaultStatus: { value: 'unsealed' as 'uninitialized' | 'sealed' | 'unsealed' },
}))

vi.mock('../modules/vault/key-service.js', () => ({
  getVaultStatus: () => mockVaultStatus.value,
}))

// Story 14.2: /health's extensions_status comes from the loader's module-level state. Mocked
// here so this route-level test can control all three values without loading a real extension
// package; loader.test.ts covers the loader's own state-transition logic directly.
const { mockExtensionsHealth } = vi.hoisted(() => ({
  mockExtensionsHealth: {
    value: 'not_configured' as 'not_configured' | 'loaded' | 'load_failed',
  },
}))

vi.mock('../extensions/loader.js', () => ({
  loadExtension: async () => undefined,
  getExtensionsHealthField: () => mockExtensionsHealth.value,
  // Story 14.3 Task 3: createApp() now also calls getExtensionStatus() (via
  // wireExtensionAuthStrategy()) after loadExtension() resolves — this route-level test mocks
  // loader.js wholesale (see comment above), so it must supply this export too, distinct from
  // getExtensionsHealthField's own health-endpoint-only shape. Always resolves to
  // 'not_configured' here since this file only exercises /health's extensions_status field, never
  // an actual registered auth strategy.
  getExtensionStatus: () => ({ status: 'not_configured' as const }),
}))

// Story 16.1 AC-9: /health's themesLoaded/themesFailed come from the theming service's
// module-level state. Mocked here (same rationale as loader.js above) so this route-level test
// controls both counts directly; service.test.ts covers the reload logic itself.
const { mockThemesHealth } = vi.hoisted(() => ({
  mockThemesHealth: { themesLoaded: 0, themesFailed: 0 },
}))

vi.mock('../modules/theming/service.js', () => ({
  reloadThemesWithFanout: async () => ({ loaded: [], failed: [] }),
  getThemesHealthField: () => mockThemesHealth,
}))

beforeEach(() => {
  mockVaultStatus.value = 'unsealed'
  mockExtensionsHealth.value = 'not_configured'
  mockThemesHealth.themesLoaded = 0
  mockThemesHealth.themesFailed = 0
})

describe('GET /health', () => {
  it('returns 200 with status ok and version', async () => {
    const app = await createApp({ logger: false })

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json<{ status: string; version: string }>()
    expect(body.status).toBe('ok')
    expect(typeof body.version).toBe('string')
    await app.close()
  })

  // Story 23.2 AC-13: the login screen's SSO-only-rendering decision depends on this field.
  // extensions_status is mocked 'not_configured' by this file's wholesale loader.js mock (see
  // top of file), so replacementDeclared is always false here — zero DB reads, native login
  // stays enabled, matching every self-hosted deployment that installs no extension (AC-16).
  describe('Story 23.2 AC-13: nativeLoginEnabled', () => {
    it('is true with no extension configured, and no DB query is made', async () => {
      const app = await createApp({ logger: false })

      const response = await app.inject({ method: 'GET', url: '/health' })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ nativeLoginEnabled: boolean }>()
      expect(body.nativeLoginEnabled).toBe(true)
      await app.close()
    })
  })

  // Story 9.10 AC-1/AC-6: /health's version must come from getReleaseVersion() (RELEASE_VERSION
  // env var), never a hardcoded/package.json-sourced 0.0.1 placeholder, and must carry an
  // explicit versionSource so callers (e.g. Version & Upgrade) can distinguish a real release
  // from the documented dev fallback.
  describe('Story 9.10: release version reporting', () => {
    const originalReleaseVersion = process.env.RELEASE_VERSION

    afterEach(() => {
      if (originalReleaseVersion === undefined) delete process.env.RELEASE_VERSION
      else process.env.RELEASE_VERSION = originalReleaseVersion
    })

    it('AC-1: reports the injected RELEASE_VERSION and versionSource "release" when set', async () => {
      process.env.RELEASE_VERSION = '1.0.2'
      const app = await createApp({ logger: false })

      const response = await app.inject({ method: 'GET', url: '/health' })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ version: string; versionSource: string }>()
      expect(body.version).toBe('1.0.2')
      expect(body.versionSource).toBe('release')
      await app.close()
    })

    it('AC-1: reports the documented dev fallback and versionSource "development" when unset', async () => {
      delete process.env.RELEASE_VERSION
      const app = await createApp({ logger: false })

      const response = await app.inject({ method: 'GET', url: '/health' })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ version: string; versionSource: string }>()
      expect(body.version).toBe('dev')
      expect(body.version).not.toBe('0.0.1')
      expect(body.versionSource).toBe('development')
      await app.close()
    })

    // AC-4: version reporting must be observable and correct regardless of vault/DB readiness —
    // /health is orthogonal to /ready's gating.
    it('AC-4: still reports the correct release version while the vault is sealed', async () => {
      process.env.RELEASE_VERSION = '1.0.2'
      mockVaultStatus.value = 'sealed'
      const app = await createApp({ logger: false })

      const response = await app.inject({ method: 'GET', url: '/health' })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ version: string }>()
      expect(body.version).toBe('1.0.2')
      await app.close()
    })
  })

  describe('Story 14.2: extensions_status', () => {
    it('is "not_configured" when no extension is configured (AC-1)', async () => {
      const app = await createApp({ logger: false })

      const response = await app.inject({ method: 'GET', url: '/health' })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ extensions_status: string }>()
      expect(body.extensions_status).toBe('not_configured')
      await app.close()
    })

    it.each(['loaded', 'load_failed'] as const)(
      'reports extensions_status "%s" without requiring auth and without a non-200 status (AC-2/3/6)',
      async (status) => {
        mockExtensionsHealth.value = status
        const app = await createApp({ logger: false })

        const response = await app.inject({ method: 'GET', url: '/health' })

        expect(response.statusCode).toBe(200)
        const body = response.json<{ extensions_status: string }>()
        expect(body.extensions_status).toBe(status)
        await app.close()
      }
    )
  })

  describe('Story 16.1 AC-9: themesLoaded/themesFailed', () => {
    it('defaults to 0/0 before any reload has run', async () => {
      const app = await createApp({ logger: false })

      const response = await app.inject({ method: 'GET', url: '/health' })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ themesLoaded: number; themesFailed: number }>()
      expect(body.themesLoaded).toBe(0)
      expect(body.themesFailed).toBe(0)
      await app.close()
    })

    it('reports the current loaded/failed counts', async () => {
      mockThemesHealth.themesLoaded = 2
      mockThemesHealth.themesFailed = 1
      const app = await createApp({ logger: false })

      const response = await app.inject({ method: 'GET', url: '/health' })

      expect(response.statusCode).toBe(200)
      const body = response.json<{ themesLoaded: number; themesFailed: number }>()
      expect(body.themesLoaded).toBe(2)
      expect(body.themesFailed).toBe(1)
      await app.close()
    })

    it('never exposes filenames or failure reasons — counts only', async () => {
      mockThemesHealth.themesLoaded = 2
      mockThemesHealth.themesFailed = 1
      const app = await createApp({ logger: false })

      const response = await app.inject({ method: 'GET', url: '/health' })
      const body = response.json<Record<string, unknown>>()

      expect(JSON.stringify(body)).not.toContain('"file"')
      expect(JSON.stringify(body)).not.toContain('"reason"')
      await app.close()
    })
  })
})

describe('GET /ready', () => {
  async function expectUnavailableReady(reason: 'uninitialized' | 'sealed', message: string) {
    mockVaultStatus.value = reason
    const app = await createApp({ logger: false })
    const response = await app.inject({ method: 'GET', url: '/ready' })

    expect(response.statusCode).toBe(503)
    expect(response.json<{ status: string; reason: string; message: string }>()).toEqual({
      status: 'unavailable',
      reason,
      message,
    })
    await app.close()
  }

  it('returns a distinct uninitialized reason before vault initialization', async () => {
    await expectUnavailableReady(
      'uninitialized',
      'Vault not initialized. POST /api/v1/vault/init to initialize.'
    )
  })

  it('returns a sealed reason when manual unseal is required', async () => {
    await expectUnavailableReady('sealed', 'Manual unseal required via POST /api/v1/vault/unseal')
  })

  it('AC-18: returns no warnings key at all on a healthy instance (additive, backward-compatible)', async () => {
    const mockDbPool = {
      query: vi.fn().mockResolvedValue([]),
    }
    const app = await createApp({ logger: false, dbPool: mockDbPool })
    const response = await app.inject({ method: 'GET', url: '/ready' })

    expect(response.statusCode).toBe(200)
    const body = response.json<Record<string, unknown>>()
    expect(body).toEqual({ status: 'ready' })
    expect(body).not.toHaveProperty('warnings')
    await app.close()
  })

  it('AC-18: includes warnings for active audit_storage.critical and key_custody_risk alerts, status stays "ready"', async () => {
    const mockDbPool = {
      query: vi.fn().mockImplementation(async (statement: string) => {
        if (statement.includes('admin_alerts')) {
          return [{ alert_type: 'audit_storage.critical' }, { alert_type: 'key_custody_risk' }]
        }
        return []
      }),
    }
    const app = await createApp({ logger: false, dbPool: mockDbPool })
    const response = await app.inject({ method: 'GET', url: '/ready' })

    expect(response.statusCode).toBe(200)
    const body = response.json<{ status: string; warnings: string[] }>()
    expect(body.status).toBe('ready')
    expect(body.warnings).toEqual(
      expect.arrayContaining(['audit_storage_critical', 'key_custody_risk'])
    )
    await app.close()
  })

  it('returns 200 when DB pool resolves', async () => {
    const mockDbPool = {
      query: vi.fn().mockResolvedValue([]),
    }
    const app = await createApp({ logger: false, dbPool: mockDbPool })
    const response = await app.inject({ method: 'GET', url: '/ready' })

    expect(response.statusCode).toBe(200)
    expect(response.json<{ status: string }>().status).toBe('ready')
    await app.close()
  })

  it('returns 503 when DB pool rejects', async () => {
    const mockDbPool = {
      query: vi.fn().mockRejectedValue(new Error('Connection refused')),
    }
    const app = await createApp({ logger: false, dbPool: mockDbPool })
    const response = await app.inject({ method: 'GET', url: '/ready' })

    expect(response.statusCode).toBe(503)
    const body = response.json<{ status: string; reason: string }>()
    expect(body.status).toBe('unavailable')
    expect(body.reason).toBe('db')
    await app.close()
  })

  it('logs a structured db.error when DB pool rejects', async () => {
    const { stream, lines } = createLogCaptureStream()
    const mockDbPool = {
      query: vi.fn().mockRejectedValue(new Error('Connection refused')),
    }
    const app = await createApp({
      logger: {
        ...createLoggerConfig({ NODE_ENV: 'development', LOG_LEVEL: 'info', SERVICE_NAME: 'api' }),
        stream,
      },
      dbPool: mockDbPool,
    })
    const response = await app.inject({ method: 'GET', url: '/ready' })
    await (app.log as { flush?: () => void | Promise<void> }).flush?.()

    expect(response.statusCode).toBe(503)
    const parsed = lines
      .join('')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(parsed).toContainEqual(
      expect.objectContaining({
        level: 'error',
        eventType: OperationalEvent.DB_ERROR,
        message: 'Database query failed',
      })
    )
    await app.close()
  })

  it('returns 503 when no DB pool configured', async () => {
    const app = await createApp({ logger: false })
    const response = await app.inject({ method: 'GET', url: '/ready' })

    expect(response.statusCode).toBe(503)
    expect(response.json<{ status: string }>().status).toBe('unavailable')
    await app.close()
  })
})
