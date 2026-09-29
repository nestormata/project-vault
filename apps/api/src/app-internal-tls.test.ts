import { X509Certificate } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import pino from 'pino'
import { register } from 'prom-client'
import { Agent, request } from 'undici'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { OperationalEvent } from '@project-vault/shared'
import { createTestPki, type TestPki, type TestPkiLeaf } from '@project-vault/shared/test-pki'
import { createApp } from './app.js'
import type { ApiListenerTls } from './config/internal-tls.js'
import { createLogCaptureStream, parseCapturedLogLines } from './__tests__/helpers/capture-logs.js'
import { logInternalTlsStartup } from './lib/internal-tls-status.js'
import type { FastifyApp } from './lib/fastify-app.js'

// Story 43.16 AC-1 / AC-9 / AC-14: the real app booted on an ephemeral port with a runtime test
// PKI. Every certificate and key here is test-only material minted by openssl (Task 1).

vi.mock('./config/env.js', () => ({
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

vi.mock('./modules/vault/key-service.js', () => ({
  getVaultStatus: () => 'unsealed',
}))

vi.mock('./extensions/loader.js', () => ({
  loadExtension: async () => undefined,
  getExtensionsHealthField: () => 'not_configured',
  getExtensionStatus: () => ({ status: 'not_configured' as const }),
}))

vi.mock('./modules/theming/service.js', () => ({
  reloadThemesWithFanout: async () => ({ loaded: [], failed: [] }),
  getThemesHealthField: () => ({ themesLoaded: 0, themesFailed: 0 }),
}))

let pki: TestPki
let tenDayServer: TestPkiLeaf
let tenDayDbClient: TestPkiLeaf

beforeAll(async () => {
  pki = await createTestPki({ clientCommonName: 'project-vault-demo-web' })
  tenDayServer = await pki.issueLeaf({
    commonName: 'localhost',
    eku: 'serverAuth',
    subjectAltName: 'DNS:localhost,IP:127.0.0.1',
    days: 10,
  })
  tenDayDbClient = await pki.issueLeaf({
    commonName: 'project-vault-demo-api',
    eku: 'clientAuth',
    days: 10,
  })
})

afterAll(async () => {
  await pki.cleanup()
})

function listenerTls(server: TestPkiLeaf, clientCa?: string): ApiListenerTls {
  return {
    mode: clientCa ? 'mtls' : 'tls',
    cert: server.certPem,
    key: server.keyPem,
    ...(clientCa ? { clientCa } : {}),
    leaf: new X509Certificate(server.certPem),
  }
}

const apps: FastifyApp[] = []

async function boot(
  options: Parameters<typeof createApp>[0]
): Promise<{ app: FastifyApp; port: number }> {
  const app = await createApp({ logger: false, ...options })
  apps.push(app)
  await app.listen({ port: 0, host: '127.0.0.1' })
  return { app, port: (app.server.address() as AddressInfo).port }
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

type ClientTls = { ca?: string; cert?: string; key?: string; maxVersion?: 'TLSv1.2' | 'TLSv1.3' }

async function tlsGet(
  port: number,
  path: string,
  tls: ClientTls
): Promise<{ status: number; body: string }> {
  const dispatcher = new Agent({ connect: { servername: 'localhost', ...tls } })
  try {
    const response = await request(`https://localhost:${port}${path}`, { dispatcher })
    return { status: response.statusCode, body: await response.body.text() }
  } finally {
    await dispatcher.close()
  }
}

describe('Story 43.16 AC-1: api listener TLS / mTLS', () => {
  it('✅ mTLS: a client with the CA-signed web cert gets GET /health → 200', async () => {
    const { port } = await boot({
      internalTls: { listener: listenerTls(pki.server, pki.ca.certPem) },
    })
    const response = await tlsGet(port, '/health', {
      ca: pki.ca.certPem,
      cert: pki.client.certPem,
      key: pki.client.keyPem,
    })
    expect(response.status).toBe(200)
  })

  it('✅ TLS only (no client CA): server verification alone reaches /health', async () => {
    const { port } = await boot({ internalTls: { listener: listenerTls(pki.server) } })
    expect((await tlsGet(port, '/health', { ca: pki.ca.certPem })).status).toBe(200)
  })

  it('✅ off: plain http /health → 200 exactly as today', async () => {
    const { port } = await boot({ internalTls: { listener: null } })
    const response = await request(`http://127.0.0.1:${port}/health`)
    expect(response.statusCode).toBe(200)
    await response.body.dump()
  })

  it('❌ no client cert: the handshake fails and no HTTP response is produced', async () => {
    const { port } = await boot({
      internalTls: { listener: listenerTls(pki.server, pki.ca.certPem) },
    })
    await expect(tlsGet(port, '/health', { ca: pki.ca.certPem })).rejects.toThrow()
  })

  it('❌ foreign CA: a client cert signed by an unrelated CA is rejected', async () => {
    const { port } = await boot({
      internalTls: { listener: listenerTls(pki.server, pki.ca.certPem) },
    })
    await expect(
      tlsGet(port, '/health', {
        ca: pki.ca.certPem,
        cert: pki.foreignClient.certPem,
        key: pki.foreignClient.keyPem,
      })
    ).rejects.toThrow()
  })

  it('❌ plaintext to the TLS port never yields a 200', async () => {
    const { port } = await boot({
      internalTls: { listener: listenerTls(pki.server, pki.ca.certPem) },
    })
    const outcome = await request(`http://127.0.0.1:${port}/health`).then(
      async (response) => {
        await response.body.dump()
        return response.statusCode
      },
      () => 'failed'
    )
    expect(outcome).not.toBe(200)
  })

  it('❌ a TLS 1.2 client fails the handshake', async () => {
    const { port } = await boot({
      internalTls: { listener: listenerTls(pki.server, pki.ca.certPem) },
    })
    await expect(
      tlsGet(port, '/health', {
        ca: pki.ca.certPem,
        cert: pki.client.certPem,
        key: pki.client.keyPem,
        maxVersion: 'TLSv1.2',
      })
    ).rejects.toThrow()
  })

  it('❌ wrong EKU: the api server cert (serverAuth only) is rejected as a client cert', async () => {
    const { port } = await boot({
      internalTls: { listener: listenerTls(pki.server, pki.ca.certPem) },
    })
    await expect(
      tlsGet(port, '/health', {
        ca: pki.ca.certPem,
        cert: pki.server.certPem,
        key: pki.server.keyPem,
      })
    ).rejects.toThrow()
  })

  it('keeps request.ip (the per-IP rate limiters’ key) as the socket peer under mTLS', async () => {
    const app = await createApp({
      logger: false,
      internalTls: { listener: listenerTls(pki.server, pki.ca.certPem) },
    })
    apps.push(app)
    app.get('/__test/ip', async (req: { ip: string }) => ({ ip: req.ip }))
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as AddressInfo).port
    const response = await tlsGet(port, '/__test/ip', {
      ca: pki.ca.certPem,
      cert: pki.client.certPem,
      key: pki.client.keyPem,
    })
    expect(JSON.parse(response.body)).toEqual({ ip: '127.0.0.1' })
  })
})

describe('Story 43.16 AC-9: handshake-failure warn is rate limited and secret-free', () => {
  it('logs exactly one warn line for 50 failed handshakes from one address within the window', async () => {
    const capture = createLogCaptureStream()
    const app = await createApp({
      logger: { level: 'info', stream: capture.stream },
      internalTls: { listener: listenerTls(pki.server, pki.ca.certPem) },
    })
    apps.push(app)
    await app.listen({ port: 0, host: '127.0.0.1' })
    const port = (app.server.address() as AddressInfo).port

    await Promise.all(
      Array.from(
        { length: 50 },
        () =>
          new Promise<void>((resolve) => {
            const socket = tlsConnect({
              port,
              host: '127.0.0.1',
              servername: 'localhost',
              ca: pki.ca.certPem,
            })
            socket.on('error', () => resolve())
            socket.on('close', () => resolve())
            socket.on('secureConnect', () =>
              socket.write('GET /health HTTP/1.1\r\nHost: x\r\n\r\n')
            )
          })
      )
    )
    await new Promise((resolve) => setTimeout(resolve, 100))

    const lines = parseCapturedLogLines(capture.lines).filter(
      (line) => line['eventType'] === OperationalEvent.INTERNAL_TLS_HANDSHAKE_FAILED
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]?.['level']).toBe(40)
    expect(lines[0]).toMatchObject({ remoteAddress: '127.0.0.1' })
    expect(typeof lines[0]?.['code']).toBe('string')
    const raw = capture.lines.join('')
    expect(raw).not.toContain('-----BEGIN')
    expect(raw).not.toContain(pki.server.keyB64)
  })
})

describe('Story 43.16 AC-9: startup log line', () => {
  function captureStartup(
    listener: ApiListenerTls | null,
    dbClient: TestPkiLeaf | null,
    dbPinned: boolean
  ) {
    const capture = createLogCaptureStream()
    const logger = pino({ level: 'info' }, capture.stream)
    logInternalTlsStartup(
      logger,
      {
        listener,
        dbClientLeaf: dbClient ? new X509Certificate(dbClient.certPem) : null,
        dbPinned,
      },
      new Date()
    )
    return { lines: parseCapturedLogLines(capture.lines), raw: capture.lines.join('') }
  }

  it('reports mtls + pinned-ca with an ISO certNotAfter and the SAN', () => {
    const { lines, raw } = captureStartup(listenerTls(pki.server, pki.ca.certPem), pki.client, true)
    const line = lines.find(
      (entry) => entry['eventType'] === OperationalEvent.INTERNAL_TLS_CONFIGURED
    )
    expect(line).toMatchObject({ internalTls: 'mtls', dbTls: 'pinned-ca', level: 30 })
    expect(String(line?.['certNotAfter'])).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
    expect(String(line?.['certSubjectAltName'])).toContain('DNS:localhost')
    expect(raw).not.toContain('-----BEGIN')
    for (const value of [
      pki.server.certB64,
      pki.server.keyB64,
      pki.client.keyB64,
      pki.ca.certB64,
    ]) {
      expect(raw).not.toContain(value)
    }
  })

  it('reports off/off when nothing is configured', () => {
    const { lines } = captureStartup(null, null, false)
    expect(lines[0]).toMatchObject({ internalTls: 'off', dbTls: 'off', level: 30 })
  })

  it('warns with daysRemaining ≈ 10 for a 10-day server cert and a 10-day DB client cert', () => {
    const { lines } = captureStartup(
      listenerTls(tenDayServer, pki.ca.certPem),
      tenDayDbClient,
      true
    )
    const warns = lines.filter(
      (entry) => entry['eventType'] === OperationalEvent.INTERNAL_TLS_CERT_EXPIRING
    )
    expect(warns.map((entry) => entry['which']).sort()).toEqual(['api-server', 'db-client'])
    for (const warn of warns) {
      expect(warn['level']).toBe(40)
      expect(Math.abs(Number(warn['daysRemaining']) - 10)).toBeLessThanOrEqual(1)
    }
  })
})

describe('Story 43.16 AC-14: /ready expiry reason and the expiry gauge', () => {
  const dbPool = { query: vi.fn().mockResolvedValue([]) }

  beforeEach(() => {
    dbPool.query.mockClear()
  })

  async function gaugeValues(): Promise<Record<string, number>> {
    const metric = register.getSingleMetric('pv_internal_tls_cert_expiry_seconds')
    if (!metric) return {}
    const snapshot = await metric.get()
    return Object.fromEntries(
      snapshot.values.map((value) => [String(value.labels['which']), value.value])
    )
  }

  it('10-day server cert: ready + internal_tls_cert_expiring (api-server, ≈10 days), gauge ≈ 864000', async () => {
    const app = await createApp({
      logger: false,
      dbPool,
      internalTls: { listener: listenerTls(tenDayServer, pki.ca.certPem), dbClientLeaf: null },
    })
    apps.push(app)
    const response = await app.inject({ method: 'GET', url: '/ready' })
    expect(response.statusCode).toBe(200)
    const body = response.json<{
      status: string
      warnings?: string[]
      internalTlsCertExpiring?: { which: string; daysRemaining: number }[]
    }>()
    expect(body.status).toBe('ready')
    expect(body.warnings).toContain('internal_tls_cert_expiring')
    expect(body.internalTlsCertExpiring).toHaveLength(1)
    expect(body.internalTlsCertExpiring?.[0]?.which).toBe('api-server')
    expect(
      Math.abs((body.internalTlsCertExpiring?.[0]?.daysRemaining ?? 0) - 10)
    ).toBeLessThanOrEqual(1)
    const gauge = await gaugeValues()
    expect(Math.abs((gauge['api-server'] ?? 0) - 864_000)).toBeLessThan(120)
    expect(gauge).not.toHaveProperty('db-client')
  })

  it('10-day DB client cert: the reason names db-client', async () => {
    const app = await createApp({
      logger: false,
      dbPool,
      internalTls: {
        listener: listenerTls(pki.server, pki.ca.certPem),
        dbClientLeaf: new X509Certificate(tenDayDbClient.certPem),
      },
    })
    apps.push(app)
    const body = (await app.inject({ method: 'GET', url: '/ready' })).json<{
      internalTlsCertExpiring?: { which: string }[]
    }>()
    expect(body.internalTlsCertExpiring?.map((entry) => entry.which)).toEqual(['db-client'])
    const gauge = await gaugeValues()
    expect(Math.abs((gauge['api-server'] ?? 0) - 397 * 86_400)).toBeLessThan(120)
    expect(Math.abs((gauge['db-client'] ?? 0) - 864_000)).toBeLessThan(120)
  })

  it('397-day certs: no reason and no warnings key', async () => {
    const app = await createApp({
      logger: false,
      dbPool,
      internalTls: {
        listener: listenerTls(pki.server, pki.ca.certPem),
        dbClientLeaf: new X509Certificate(pki.client.certPem),
      },
    })
    apps.push(app)
    const body = (await app.inject({ method: 'GET', url: '/ready' })).json<
      Record<string, unknown>
    >()
    expect(body).toEqual({ status: 'ready' })
  })

  it('TLS off: no reason and no gauge series at all (never a misleading 0)', async () => {
    const app = await createApp({
      logger: false,
      dbPool,
      internalTls: { listener: null, dbClientLeaf: null },
    })
    apps.push(app)
    const body = (await app.inject({ method: 'GET', url: '/ready' })).json<
      Record<string, unknown>
    >()
    expect(body).toEqual({ status: 'ready' })
    expect(await gaugeValues()).toEqual({})
  })
})
