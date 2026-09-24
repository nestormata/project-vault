import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../app.js'
import { httpRequestDurationSeconds, httpRequestsTotal } from './metrics.js'

/**
 * Story 43.6 AC-7 — `GET /api/v1/client-version-policy`: public, static, tenant-free,
 * rate-limited. Boots the real app (env mocked like routes/health.test.ts) so the route is
 * exercised with the real Zod serializer, error handler and plugins.
 */

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    NODE_ENV: 'test',
    API_PORT: 3000,
    DATABASE_URL: 'postgresql://test:test@db.example.invalid:5432/test',
    CORS_ALLOWED_ORIGINS: 'https://app.example.com',
    METRICS_BIND_HOST: '127.0.0.1',
    LOG_LEVEL: 'silent',
    SERVICE_NAME: 'api',
    TRUST_PROXY: false,
    TRUST_PROXY_HOPS: 1,
    CLI_MINIMUM_SUPPORTED_VERSION: undefined as string | undefined,
    CLI_WITHDRAWN_VERSIONS: [] as string[],
  },
}))
vi.mock('../config/env.js', () => ({ env: mockEnv }))
vi.mock('../modules/vault/key-service.js', () => ({ getVaultStatus: () => 'unsealed' }))
vi.mock('../extensions/loader.js', () => ({
  loadExtension: async () => undefined,
  getExtensionsHealthField: () => 'not_configured',
  getExtensionStatus: () => ({ status: 'not_configured' as const }),
}))
vi.mock('../modules/theming/service.js', () => ({
  reloadThemesWithFanout: async () => ({ loaded: [], failed: [] }),
  getThemesHealthField: () => ({ themesLoaded: 0, themesFailed: 0 }),
}))

const URL_PATH = '/api/v1/client-version-policy'
const originalRelease = process.env['RELEASE_VERSION']
const originalBypass = process.env['RATE_LIMIT_TEST_BYPASS']

type PolicyBody = {
  data: {
    schemaVersion: number
    server: { version: string; versionSource: string }
    clients: {
      cli: {
        current: string | null
        minimumSupported: string | null
        withdrawn: { version: string; reason: string }[]
      }
    }
  }
}

beforeEach(() => {
  process.env['RATE_LIMIT_TEST_BYPASS'] = 'true'
  mockEnv.CLI_MINIMUM_SUPPORTED_VERSION = undefined
  mockEnv.CLI_WITHDRAWN_VERSIONS = []
})

afterEach(() => {
  if (originalRelease === undefined) delete process.env['RELEASE_VERSION']
  else process.env['RELEASE_VERSION'] = originalRelease
  if (originalBypass === undefined) delete process.env['RATE_LIMIT_TEST_BYPASS']
  else process.env['RATE_LIMIT_TEST_BYPASS'] = originalBypass
})

describe('GET /api/v1/client-version-policy (Story 43.6 AC-7)', () => {
  it('release server: full shape, Cache-Control public max-age=300', async () => {
    process.env['RELEASE_VERSION'] = '1.3.0'
    mockEnv.CLI_MINIMUM_SUPPORTED_VERSION = '1.1.0'
    mockEnv.CLI_WITHDRAWN_VERSIONS = ['1.2.1']
    const app = await createApp({ logger: false })
    const res = await app.inject({ method: 'GET', url: URL_PATH })
    expect(res.statusCode).toBe(200)
    expect(res.headers['cache-control']).toBe('public, max-age=300')
    expect(res.json<PolicyBody>()).toEqual({
      data: {
        schemaVersion: 1,
        server: { version: '1.3.0', versionSource: 'release' },
        clients: {
          cli: {
            current: '1.3.0',
            minimumSupported: '1.1.0',
            withdrawn: [{ version: '1.2.1', reason: "Withdrawn by this server's administrator." }],
          },
        },
      },
    })
    await app.close()
  })

  it('dev server: current null, versionSource development, empty defaults', async () => {
    delete process.env['RELEASE_VERSION']
    const app = await createApp({ logger: false })
    const body = (await app.inject({ method: 'GET', url: URL_PATH })).json<PolicyBody>()
    expect(body.data.server).toEqual({ version: 'dev', versionSource: 'development' })
    expect(body.data.clients.cli).toEqual({ current: null, minimumSupported: null, withdrawn: [] })
    await app.close()
  })

  it('a non-strict RELEASE_VERSION echoes raw server.version but reports current null', async () => {
    process.env['RELEASE_VERSION'] = '1.3.0-hotfix2'
    mockEnv.CLI_WITHDRAWN_VERSIONS = ['1.2.1']
    const app = await createApp({ logger: false })
    const body = (await app.inject({ method: 'GET', url: URL_PATH })).json<PolicyBody>()
    expect(body.data.server.version).toBe('1.3.0-hotfix2')
    expect(body.data.clients.cli.current).toBeNull()
    expect(body.data.clients.cli.withdrawn).toHaveLength(1)
    await app.close()
  })

  it('ignores credentials: an invalid bearer and a bogus cookie still get 200 with the same body', async () => {
    process.env['RELEASE_VERSION'] = '1.3.0'
    const app = await createApp({ logger: false })
    const plain = await app.inject({ method: 'GET', url: URL_PATH })
    const bearer = await app.inject({
      method: 'GET',
      url: URL_PATH,
      headers: { authorization: 'Bearer not-a-real-token', cookie: 'session=garbage' },
    })
    expect(bearer.statusCode).toBe(200)
    expect(JSON.stringify(bearer.json())).toBe(JSON.stringify(plain.json()))
    await app.close()
  })

  it('is rate-limited per IP: the 61st request in a minute is 429', async () => {
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'false'
    const app = await createApp({ logger: false })
    let last = 200
    for (let i = 0; i < 61; i += 1) {
      // sequential by design: proves a cumulative rate-limit window, not concurrency
      last = (await app.inject({ method: 'GET', url: URL_PATH })).statusCode
    }
    expect(last).toBe(429)
    await app.close()
  })

  it('makes zero DB queries', async () => {
    const dbPool = { query: vi.fn(async () => []) }
    const app = await createApp({ logger: false, dbPool })
    await app.inject({ method: 'GET', url: URL_PATH })
    expect(dbPool.query).not.toHaveBeenCalled()
    await app.close()
  })

  it('never derives a metric label from the client user-agent', async () => {
    const app = await createApp({ logger: false })
    await app.inject({
      method: 'GET',
      url: URL_PATH,
      headers: { 'user-agent': 'pvault/9.9.9-uniquelabel' },
    })
    const httpMetrics = JSON.stringify([
      await httpRequestsTotal.get(),
      await httpRequestDurationSeconds.get(),
    ])
    expect(httpMetrics).toContain('client-version-policy')
    expect(httpMetrics).not.toContain('uniquelabel')
    await app.close()
  })

  it('the route module touches no DB, audit or auth module (static, tenant-free by construction)', () => {
    const source = readFileSync(new URL('./client-version-policy.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/@project-vault\/db|modules\/audit|secure-route|\.authenticate\b/)
  })
})
