import { beforeEach, describe, it, expect, vi } from 'vitest'
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
}))

beforeEach(() => {
  mockVaultStatus.value = 'unsealed'
  mockExtensionsHealth.value = 'not_configured'
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
