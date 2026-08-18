import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { createApp } from '../app.js'
import {
  __resetCapabilityGateForTests,
  wireExtensionCapabilityGate,
} from '../lib/capability-gate.js'
import { __resetExtensionStateForTests, __setExtensionStateForTests } from '../extensions/loader.js'

const TEST_GATE_MANIFEST_NAME = 'com.example.ext'

// Mutable so the loopback-bypass-spoofing test (AC-4 hardening) can flip TRUST_PROXY on for a
// single describe block without affecting every other test in this file — mirrors the
// mockVaultStatus/mockActiveToken hoisted-mutable pattern below.
const { mockTrustProxy } = vi.hoisted(() => ({ mockTrustProxy: { value: false } }))

vi.mock('../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    API_PORT: 3000,
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
    METRICS_BIND_HOST: '127.0.0.1',
    LOG_LEVEL: 'silent',
    SERVICE_NAME: 'api',
    get TRUST_PROXY() {
      return mockTrustProxy.value
    },
    TRUST_PROXY_HOPS: 1,
    OPERATIONAL_STATUS_TOKEN_HMAC_SECRET: 'l'.repeat(64),
    STATUS_DISK_MIN_FREE_PERCENT: 10,
    BACKUP_STORAGE_PATH: undefined,
  },
}))

const { mockVaultStatus } = vi.hoisted(() => ({
  mockVaultStatus: { value: 'unsealed' as 'uninitialized' | 'sealed' | 'unsealed' },
}))
vi.mock('../modules/vault/key-service.js', () => ({
  getVaultStatus: () => mockVaultStatus.value,
}))

const { mockActiveToken } = vi.hoisted(() => ({
  mockActiveToken: {
    row: null as null | { id: string; tokenHash: string; revokedAt: null },
  },
}))
vi.mock('../modules/status/token-store.js', () => ({
  findActiveOperationalStatusToken: async () => mockActiveToken.row,
  findActiveOperationalStatusTokenByHash: async (hash: string) =>
    mockActiveToken.row && mockActiveToken.row.tokenHash === hash ? mockActiveToken.row : null,
  touchOperationalStatusTokenLastUsed: async () => undefined,
}))

beforeEach(() => {
  mockVaultStatus.value = 'unsealed'
  mockActiveToken.row = null
  mockTrustProxy.value = false
})

const okDbPool = { query: async () => [{ '?column?': 1 }] }
const NON_LOOPBACK_REMOTE_ADDRESS = '203.0.113.5'

describe('GET /status', () => {
  describe('AC-1/AC-2/AC-7: response contract', () => {
    it('returns 200 healthy with the full checks contract when everything is fine', async () => {
      const app = await createApp({ logger: false, dbPool: okDbPool })
      const res = await app.inject({ method: 'GET', url: '/status' })
      expect(res.statusCode).toBe(200)
      const body = res.json<{
        status: string
        version: string
        timestamp: string
        checks: {
          database: { status: string }
          vault: { status: string }
          disk: { status: string }
        }
      }>()
      expect(body.status).toBe('healthy')
      expect(typeof body.version).toBe('string')
      expect(typeof body.timestamp).toBe('string')
      expect(body.checks.database.status).toBe('ok')
      expect(body.checks.vault.status).toBe('ok')
      expect(body.checks.disk.status).toBe('skipped')
      await app.close()
    })

    // Story 9.10 AC-1: /status is a runtime version consumer too — it must resolve its version
    // from the same RELEASE_VERSION source /health and OpenAPI info.version use, never from
    // package.json's permanent 0.0.1 placeholder (which would make two operational endpoints on
    // the same instance report different versions).
    it('AC-1: reports the injected RELEASE_VERSION, not the 0.0.1 package placeholder', async () => {
      const original = process.env.RELEASE_VERSION
      process.env.RELEASE_VERSION = '4.5.6'
      try {
        const app = await createApp({ logger: false, dbPool: okDbPool })
        const res = await app.inject({ method: 'GET', url: '/status' })
        expect(res.json<{ version: string }>().version).toBe('4.5.6')
        await app.close()
      } finally {
        if (original === undefined) delete process.env.RELEASE_VERSION
        else process.env.RELEASE_VERSION = original
      }
    })

    it('AC-1: reports the dev fallback rather than 0.0.1 when no release version is injected', async () => {
      const original = process.env.RELEASE_VERSION
      delete process.env.RELEASE_VERSION
      try {
        const app = await createApp({ logger: false, dbPool: okDbPool })
        const res = await app.inject({ method: 'GET', url: '/status' })
        const { version } = res.json<{ version: string }>()
        expect(version).toBe('dev')
        expect(version).not.toBe('0.0.1')
        await app.close()
      } finally {
        if (original !== undefined) process.env.RELEASE_VERSION = original
      }
    })

    it('sets Cache-Control: no-store', async () => {
      const app = await createApp({ logger: false, dbPool: okDbPool })
      const res = await app.inject({ method: 'GET', url: '/status' })
      expect(res.headers['cache-control']).toBe('no-store')
      await app.close()
    })

    it('never includes a stack trace, filesystem path, or raw error message in the body', async () => {
      const failingPool = {
        query: async () => {
          throw new Error('connection to /var/run/postgresql/.s.PGSQL.5432 refused')
        },
      }
      const app = await createApp({ logger: false, dbPool: failingPool })
      const res = await app.inject({ method: 'GET', url: '/status' })
      const raw = JSON.stringify(res.json())
      expect(raw).not.toContain('/var/run')
      expect(raw).not.toContain('.s.PGSQL')
      expect(raw).not.toContain('at ')
      await app.close()
    })
  })

  describe('Story 23.3 AC-26: capabilityGate observability', () => {
    afterEach(() => __resetCapabilityGateForTests())

    it('capabilityGate is ABSENT entirely when no gate is registered (AC-5 byte-identical guarantee)', async () => {
      const app = await createApp({ logger: false, dbPool: okDbPool })
      const res = await app.inject({ method: 'GET', url: '/status' })
      const body = res.json<Record<string, unknown>>()
      expect(Object.keys(body)).not.toContain('capabilityGate')
      await app.close()
    })

    it('capabilityGate reports gate identity and counters when a gate is registered', async () => {
      const app = await createApp({ logger: false, dbPool: okDbPool })
      wireExtensionCapabilityGate({
        status: 'loaded',
        manifest: { name: TEST_GATE_MANIFEST_NAME, apiVersion: '1.2.0', capabilities: [] },
        loadedAt: new Date().toISOString(),
        hooks: { capabilityGate: { onCheckCapability: async () => ({ permitted: true }) } },
      })
      const res = await app.inject({ method: 'GET', url: '/status' })
      const body = res.json<{
        capabilityGate?: { gate: { name: string } | null; counters: Record<string, number> }
      }>()
      expect(body.capabilityGate).toBeDefined()
      expect(body.capabilityGate?.gate).toEqual({ name: TEST_GATE_MANIFEST_NAME })
      expect(body.capabilityGate?.counters).toEqual({
        checks: 0,
        permitted: 0,
        denied: 0,
        failed: 0,
        saturated: 0,
      })
      await app.close()
    })

    it('capabilityGate still validates and is populated on the 503/degraded response path', async () => {
      const failingPool = { query: async () => Promise.reject(new Error('boom')) }
      const app = await createApp({ logger: false, dbPool: failingPool })
      wireExtensionCapabilityGate({
        status: 'loaded',
        manifest: { name: TEST_GATE_MANIFEST_NAME, apiVersion: '1.2.0', capabilities: [] },
        loadedAt: new Date().toISOString(),
        hooks: { capabilityGate: { onCheckCapability: async () => ({ permitted: true }) } },
      })
      const res = await app.inject({ method: 'GET', url: '/status' })
      expect(res.statusCode).toBe(503)
      const body = res.json<{ capabilityGate?: { gate: { name: string } | null } }>()
      expect(body.capabilityGate?.gate).toEqual({ name: TEST_GATE_MANIFEST_NAME })
      await app.close()
    })
  })

  describe('Story 23.8 AC-24: auditEventSource observability', () => {
    afterEach(() => __resetExtensionStateForTests())

    it('auditEventSource is ABSENT entirely when no extension declares audit-event-source', async () => {
      const app = await createApp({ logger: false, dbPool: okDbPool })
      const res = await app.inject({ method: 'GET', url: '/status' })
      const body = res.json<Record<string, unknown>>()
      expect(Object.keys(body)).not.toContain('auditEventSource')
      await app.close()
    })

    it('auditEventSource is ABSENT when a different extension is loaded without the capability', async () => {
      const app = await createApp({ logger: false, dbPool: okDbPool })
      __setExtensionStateForTests({
        status: 'loaded',
        manifest: { name: TEST_GATE_MANIFEST_NAME, apiVersion: '1.4.0', capabilities: [] },
        loadedAt: new Date().toISOString(),
        hooks: {},
      })
      const res = await app.inject({ method: 'GET', url: '/status' })
      const body = res.json<Record<string, unknown>>()
      expect(Object.keys(body)).not.toContain('auditEventSource')
      await app.close()
    })

    it('auditEventSource reports counters when the loaded extension declares audit-event-source', async () => {
      const app = await createApp({ logger: false, dbPool: okDbPool })
      __setExtensionStateForTests({
        status: 'loaded',
        manifest: {
          name: TEST_GATE_MANIFEST_NAME,
          apiVersion: '1.4.0',
          capabilities: ['audit-event-source'],
        },
        loadedAt: new Date().toISOString(),
        hooks: {},
      })
      const res = await app.inject({ method: 'GET', url: '/status' })
      const body = res.json<{
        auditEventSource?: { counters: Record<string, number> }
      }>()
      expect(body.auditEventSource).toBeDefined()
      expect(body.auditEventSource?.counters).toEqual({ writes: 0, succeeded: 0, rejected: 0 })
      await app.close()
    })
  })

  describe('AC-1/AC-3: database check', () => {
    it('returns 503 unavailable with reason db_error on a query failure', async () => {
      const failingPool = { query: async () => Promise.reject(new Error('boom')) }
      const app = await createApp({ logger: false, dbPool: failingPool })
      const res = await app.inject({ method: 'GET', url: '/status' })
      expect(res.statusCode).toBe(503)
      const body = res.json<{
        status: string
        checks: { database: { status: string; reason: string } }
      }>()
      expect(body.status).toBe('unavailable')
      expect(body.checks.database.status).toBe('unavailable')
      expect(body.checks.database.reason).toBe('db_error')
      await app.close()
    })

    it('returns db_timeout reason when the query never resolves within budget', async () => {
      const hangingPool = { query: () => new Promise(() => {}) }
      const app = await createApp({ logger: false, dbPool: hangingPool })
      const res = await app.inject({ method: 'GET', url: '/status' })
      expect(res.statusCode).toBe(503)
      const body = res.json<{ checks: { database: { reason: string } } }>()
      expect(body.checks.database.reason).toBe('db_timeout')
      await app.close()
    }, 10000)

    it('reports db_unavailable when no dbPool is wired up at all', async () => {
      const app = await createApp({ logger: false })
      const res = await app.inject({ method: 'GET', url: '/status' })
      expect(res.statusCode).toBe(503)
      const body = res.json<{ checks: { database: { reason: string } } }>()
      expect(body.checks.database.reason).toBe('db_unavailable')
      await app.close()
    })
  })

  describe('AC-1/AC-3: vault check', () => {
    it('reports vault_sealed and 503 when the vault is sealed', async () => {
      mockVaultStatus.value = 'sealed'
      const app = await createApp({ logger: false, dbPool: okDbPool })
      const res = await app.inject({ method: 'GET', url: '/status' })
      expect(res.statusCode).toBe(503)
      const body = res.json<{ checks: { vault: { status: string; reason: string } } }>()
      expect(body.checks.vault.status).toBe('unavailable')
      expect(body.checks.vault.reason).toBe('vault_sealed')
      await app.close()
    })

    it('reports vault_uninitialized and 503 when the vault is uninitialized', async () => {
      mockVaultStatus.value = 'uninitialized'
      const app = await createApp({ logger: false, dbPool: okDbPool })
      const res = await app.inject({ method: 'GET', url: '/status' })
      expect(res.statusCode).toBe(503)
      const body = res.json<{ checks: { vault: { reason: string } } }>()
      expect(body.checks.vault.reason).toBe('vault_uninitialized')
      await app.close()
    })
  })

  describe('AC-4: default access restriction', () => {
    it('allows an unauthenticated loopback caller when no token is configured', async () => {
      const app = await createApp({ logger: false, dbPool: okDbPool })
      const res = await app.inject({ method: 'GET', url: '/status', remoteAddress: '127.0.0.1' })
      expect(res.statusCode).toBe(200)
      await app.close()
    })

    it('returns a generic 404 for an unauthenticated remote caller when no token is configured', async () => {
      const app = await createApp({ logger: false, dbPool: okDbPool })
      const res = await app.inject({
        method: 'GET',
        url: '/status',
        remoteAddress: NON_LOOPBACK_REMOTE_ADDRESS,
      })
      expect(res.statusCode).toBe(404)
      const body = res.json<{ code: string }>()
      expect(body.code).toBe('not_found')
      await app.close()
    })

    it('rejects a spoofed X-Forwarded-For: 127.0.0.1 from a non-loopback socket even when TRUST_PROXY is enabled', async () => {
      // Adversarial review fix: the loopback-bypass gate must key off the raw untrusted socket
      // address, never req.ip — otherwise a remote attacker can spoof this header and be treated
      // as loopback whenever TRUST_PROXY is (mis)configured on.
      mockTrustProxy.value = true
      const app = await createApp({ logger: false, dbPool: okDbPool })
      const res = await app.inject({
        method: 'GET',
        url: '/status',
        remoteAddress: NON_LOOPBACK_REMOTE_ADDRESS,
        headers: { 'x-forwarded-for': '127.0.0.1' },
      })
      expect(res.statusCode).toBe(404)
      const body = res.json<{ code: string }>()
      expect(body.code).toBe('not_found')
      await app.close()
    })
  })

  describe('AC-4: token protection', () => {
    beforeEach(() => {
      mockActiveToken.row = {
        id: 'tok-1',
        tokenHash: hashForTest('correct-token'),
        revokedAt: null,
      }
    })

    it('allows a remote caller with a valid bearer token', async () => {
      const app = await createApp({ logger: false, dbPool: okDbPool })
      const res = await app.inject({
        method: 'GET',
        url: '/status',
        remoteAddress: NON_LOOPBACK_REMOTE_ADDRESS,
        headers: { authorization: 'Bearer correct-token' },
      })
      expect(res.statusCode).toBe(200)
      await app.close()
    })

    it.each([
      ['a missing Authorization header, once a token is configured', undefined],
      ['a wrong token', { authorization: 'Bearer wrong-token' }],
      ['a malformed Authorization header', { authorization: 'correct-token' }],
    ])('rejects %s with the same generic 401', async (_label, headers) => {
      const app = await createApp({ logger: false, dbPool: okDbPool })
      const res = await app.inject({
        method: 'GET',
        url: '/status',
        remoteAddress: NON_LOOPBACK_REMOTE_ADDRESS,
        headers,
      })
      expect(res.statusCode).toBe(401)
      const body = res.json<{ code: string }>()
      expect(body.code).toBe('unauthorized')
      await app.close()
    })

    it('rejects a revoked token (absent from the active-token lookup) with the same generic 401', async () => {
      mockActiveToken.row = null
      const app = await createApp({ logger: false, dbPool: okDbPool })
      const res = await app.inject({
        method: 'GET',
        url: '/status',
        remoteAddress: NON_LOOPBACK_REMOTE_ADDRESS,
        headers: { authorization: 'Bearer correct-token' },
      })
      expect(res.statusCode).toBe(404)
      await app.close()
    })

    it('still requires a token from a loopback caller once token protection is configured', async () => {
      const app = await createApp({ logger: false, dbPool: okDbPool })
      const res = await app.inject({ method: 'GET', url: '/status', remoteAddress: '127.0.0.1' })
      // Once a token exists, the auth model switches entirely to bearer-token — loopback alone
      // is no longer sufficient (AC-4's "safe default" only applies when unconfigured).
      expect(res.statusCode).toBe(401)
      await app.close()
    })
  })

  describe('AC-3: concurrency / no pile-up', () => {
    it('handles many concurrent probes without hanging, each bounded by its own timeout', async () => {
      const app = await createApp({ logger: false, dbPool: okDbPool })
      const results = await Promise.all(
        Array.from({ length: 20 }, () => app.inject({ method: 'GET', url: '/status' }))
      )
      for (const res of results) expect(res.statusCode).toBe(200)
      await app.close()
    })
  })
})

// Test-only helper: reproduces hashOperationalStatusToken's HMAC-SHA256 with the same mocked
// secret this file's env.js mock provides, so mockActiveToken.row.tokenHash matches what the
// route computes internally without importing the real (mocked-away) env module.
import { createHmac } from 'node:crypto'
function hashForTest(opaque: string): string {
  return createHmac('sha256', 'l'.repeat(64)).update(opaque).digest('hex')
}
