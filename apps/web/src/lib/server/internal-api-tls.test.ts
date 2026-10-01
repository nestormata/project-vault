/**
 * @vitest-environment node
 */
import { X509Certificate } from 'node:crypto'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo } from 'node:net'
import type { TLSSocket } from 'node:tls'
import { Agent } from 'undici'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTestPki, type TestPki, type TestPkiLeaf } from '@project-vault/shared/test-pki'
import { resolveAuthContext } from './auth-guard.js'
import { proxyApiRequest } from './api-proxy.js'
import { createInternalApiFetch, type InternalApiLogLine } from './internal-api-tls.js'
import { createServerApiFetch } from './server-api-fetch.js'

// Story 43.16 AC-2 / AC-9: the web's server-side hop to the api over TLS / mTLS. A local
// node:https server stands in for the api; every certificate and key is test-only material minted
// by openssl at runtime.

vi.mock('$env/dynamic/private', () => ({ env: {} }))

type Seen = {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: Buffer
  peerCn: string | null
}

type TestServer = { baseUrl: string; seen: Seen[]; close: () => Promise<void> }

let pki: TestPki
let tenDayClient: TestPkiLeaf
const servers: TestServer[] = []

beforeAll(async () => {
  pki = await createTestPki({ clientCommonName: 'project-vault-demo-web' })
  tenDayClient = await pki.issueLeaf({
    commonName: 'project-vault-demo-web',
    eku: 'clientAuth',
    days: 10,
  })
})

afterAll(async () => {
  await Promise.all(servers.map((server) => server.close()))
  await pki.cleanup()
})

type Reply = { status: number; body: unknown; setCookie?: string[] }

const UNAUTHENTICATED: Reply = { status: 401, body: { code: 'unauthenticated' } }

const OK_BODY = { data: { ok: true } }

/** A tiny stand-in for the api's session routes: login → me (401 until refreshed) → refresh →
 * logout, all returning Set-Cookie exactly as the real api does. An explicit switch (not a
 * url-keyed map of handlers) so the request URL never selects which function runs. */
function sessionRouteReply(url: string, cookie: string): Reply | null {
  switch (url) {
    case '/api/v1/auth/login':
      return {
        status: 200,
        body: OK_BODY,
        setCookie: ['session=S1; Path=/; HttpOnly', 'refresh-token=R1; Path=/; HttpOnly'],
      }
    case '/api/v1/auth/refresh':
      return cookie.includes('refresh-token=R1')
        ? { status: 200, body: OK_BODY, setCookie: ['session=S2; Path=/; HttpOnly'] }
        : UNAUTHENTICATED
    case '/api/v1/auth/me':
      return cookie.includes('session=S2') || cookie.includes('pv_session=abc')
        ? { status: 200, body: { data: { id: 'user-1', email: 'user@invalid' } } }
        : UNAUTHENTICATED
    case '/api/v1/auth/logout':
      return { status: 200, body: OK_BODY, setCookie: ['session=; Path=/; Max-Age=0'] }
    default:
      return null
  }
}

function peerCommonName(req: IncomingMessage): string | null {
  const socket = req.socket as TLSSocket
  if (typeof socket.getPeerCertificate !== 'function') return null
  const cn = socket.getPeerCertificate().subject?.CN
  return cn ? String(cn) : null
}

function apiHandler(seen: Seen[]) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
        peerCn: peerCommonName(req),
      })
      const reply = sessionRouteReply(req.url ?? '', req.headers.cookie ?? '') ?? {
        status: 200,
        body: { status: 'ok', echoBytes: body.length },
      }
      res.writeHead(reply.status, {
        'content-type': 'application/json',
        ...(reply.setCookie ? { 'set-cookie': reply.setCookie } : {}),
      })
      res.end(JSON.stringify(reply.body))
    })
  }
}

async function listen(
  server: ReturnType<typeof createHttpServer>,
  scheme: 'http' | 'https',
  seen: Seen[]
) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const entry: TestServer = {
    baseUrl: `${scheme}://localhost:${port}`,
    seen,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
  servers.push(entry)
  return entry
}

async function mtlsServer(serverLeaf: TestPkiLeaf = pki.server): Promise<TestServer> {
  const seen: Seen[] = []
  const server = createHttpsServer(
    {
      key: serverLeaf.keyPem,
      cert: serverLeaf.certPem,
      ca: [pki.ca.certPem],
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3',
    },
    apiHandler(seen)
  )
  return listen(server as unknown as ReturnType<typeof createHttpServer>, 'https', seen)
}

async function plainServer(): Promise<TestServer> {
  const seen: Seen[] = []
  return listen(createHttpServer(apiHandler(seen)), 'http', seen)
}

function mtlsEnv(baseUrl: string, client: TestPkiLeaf = pki.client) {
  return {
    API_BASE_URL: baseUrl,
    API_TLS_CA_B64: pki.ca.certB64,
    API_TLS_CLIENT_CERT_B64: client.certB64,
    API_TLS_CLIENT_KEY_B64: client.keyB64,
  }
}

function captureLog() {
  const lines: InternalApiLogLine[] = []
  return { lines, log: (line: InternalApiLogLine) => lines.push(line) }
}

describe('Story 43.16 AC-2: createInternalApiFetch', () => {
  it('✅ mTLS: createServerApiFetch reaches the api with the cookie and a verified web client cert', async () => {
    const server = await mtlsServer()
    const internal = createInternalApiFetch(mtlsEnv(server.baseUrl), { log: captureLog().log })
    const apiFetch = createServerApiFetch({ apiBaseUrl: server.baseUrl, fetchFn: internal })
    const response = await apiFetch('/api/v1/auth/me', { headers: { cookie: 'pv_session=abc' } })
    expect(response.status).toBe(200)
    expect(server.seen.at(-1)?.headers.cookie).toBe('pv_session=abc')
    expect(server.seen.at(-1)?.peerCn).toBe('project-vault-demo-web')
  })

  it('✅ proxy path: a POST body (duplex half) reaches the mTLS api intact', async () => {
    const server = await mtlsServer()
    const internal = createInternalApiFetch(mtlsEnv(server.baseUrl), { log: captureLog().log })
    const payload = Buffer.from(JSON.stringify({ name: 'x'.repeat(5000), n: 42 }))
    const response = await proxyApiRequest({
      fetchFn: internal,
      request: new Request('http://web.test/api/v1/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      }),
      path: 'projects',
      apiBaseUrl: server.baseUrl,
    })
    expect(response.status).toBe(200)
    expect(server.seen.at(-1)?.body.equals(payload)).toBe(true)
  })

  it('✅ off: no TLS variables and an http base URL call plain fetch without a dispatcher', async () => {
    const server = await plainServer()
    const baseFetch = vi.fn(globalThis.fetch)
    const internal = createInternalApiFetch(
      { API_BASE_URL: server.baseUrl },
      { baseFetch, log: captureLog().log }
    )
    const response = await internal(`${server.baseUrl}/health`)
    expect(response.status).toBe(200)
    expect(baseFetch).toHaveBeenCalledWith(`${server.baseUrl}/health`, undefined)
  })

  it('⚠️ empty TLS variables with http://api:3000 are treated as TLS off (compose shape)', async () => {
    const baseFetch = vi.fn(async () => new Response('ok'))
    const internal = createInternalApiFetch(
      {
        API_BASE_URL: 'http://api:3000',
        API_TLS_CA_B64: '',
        API_TLS_CLIENT_CERT_B64: ' ',
        API_TLS_CLIENT_KEY_B64: '',
      },
      { baseFetch, log: captureLog().log }
    )
    await internal('http://api:3000/ready')
    expect(baseFetch).toHaveBeenCalledWith('http://api:3000/ready', undefined)
  })

  it('❌ wrong server CA: the fetch rejects and proxyApiRequest maps it to 503 api_unreachable', async () => {
    const server = await mtlsServer(pki.foreignServer)
    const internal = createInternalApiFetch(mtlsEnv(server.baseUrl), { log: captureLog().log })
    const response = await proxyApiRequest({
      fetchFn: internal,
      request: new Request('http://web.test/api/v1/auth/me'),
      path: 'auth/me',
      apiBaseUrl: server.baseUrl,
    })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      status: 'unavailable',
      reason: 'api_unreachable',
    })
    expect(server.seen).toHaveLength(0)
  })

  it('❌ TLS variables with an http:// API_BASE_URL fail closed, never sending plaintext', async () => {
    const baseFetch = vi.fn(async () => new Response('ok'))
    const internal = createInternalApiFetch(
      { ...mtlsEnv('http://api.internal:3000') },
      { baseFetch, log: captureLog().log }
    )
    await expect(internal('http://api.internal:3000/ready')).rejects.toThrow(
      'API_BASE_URL must be https:// when API_TLS_* is set'
    )
    expect(baseFetch).not.toHaveBeenCalled()
  })

  it('⚠️ unset API_BASE_URL is the plain-http dev default: off without TLS vars, an error with them', async () => {
    const baseFetch = vi.fn(async () => new Response('ok'))
    await createInternalApiFetch({}, { baseFetch, log: captureLog().log })('/x')
    expect(baseFetch).toHaveBeenCalledWith('/x', undefined)
    const withCa = createInternalApiFetch(
      { API_TLS_CA_B64: pki.ca.certB64 },
      { baseFetch, log: captureLog().log }
    )
    await expect(withCa('/x')).rejects.toThrow(
      'API_BASE_URL must be https:// when API_TLS_* is set'
    )
  })

  it('⚠️ https://*.internal without API_TLS_CA_B64 is a config error, not a deep cert failure', async () => {
    const baseFetch = vi.fn(async () => new Response('ok'))
    const internal = createInternalApiFetch(
      { API_BASE_URL: 'https://x.internal:3000' },
      { baseFetch, log: captureLog().log }
    )
    await expect(internal('https://x.internal:3000/ready')).rejects.toThrow(
      'API_TLS_CA_B64 is required when API_BASE_URL is an https://*.internal URL'
    )
    expect(baseFetch).not.toHaveBeenCalled()
  })

  it('❌ a half client pair or a client pair without the CA fails closed naming the variable only', async () => {
    const half = createInternalApiFetch(
      {
        API_BASE_URL: 'https://localhost:1',
        API_TLS_CA_B64: pki.ca.certB64,
        API_TLS_CLIENT_CERT_B64: pki.client.certB64,
      },
      { log: captureLog().log }
    )
    await expect(half('https://localhost:1/x')).rejects.toThrow(
      'API_TLS_CLIENT_KEY_B64 is required when API_TLS_CLIENT_CERT_B64 is set'
    )
    const noCa = createInternalApiFetch(
      {
        API_BASE_URL: 'https://localhost:1',
        API_TLS_CLIENT_CERT_B64: pki.client.certB64,
        API_TLS_CLIENT_KEY_B64: pki.client.keyB64,
      },
      { log: captureLog().log }
    )
    const error = await noCa('https://localhost:1/x').catch((caught: unknown) => caught)
    if (!(error instanceof Error)) throw new Error('expected the request to reject with an Error')
    expect(error.message).toBe('API_TLS_CA_B64 is required when API_TLS_CLIENT_CERT_B64 is set')
    expect(error.message).not.toContain(pki.client.keyB64)
  })

  it('⚠️ handoff synthetic https://handoff.internal Request works with TLS off (the .internal rule is API_BASE_URL-only)', async () => {
    const server = await plainServer()
    const internal = createInternalApiFetch(
      { API_BASE_URL: server.baseUrl },
      { log: captureLog().log }
    )
    const response = await proxyApiRequest({
      fetchFn: internal,
      request: new Request('https://handoff.internal/exchange-claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pendingId: 'p', claim: 'c' }),
      }),
      path: 'auth/handoff/exchange-claim',
      apiBaseUrl: server.baseUrl,
    })
    expect(response.status).toBe(200)
    expect(server.seen.at(-1)?.url).toBe('/api/v1/auth/handoff/exchange-claim')
  })

  it('⚠️ 20 concurrent calls on a cold instance build exactly one Agent and all succeed over mTLS', async () => {
    const server = await mtlsServer()
    const createAgent = vi.fn(
      (options: ConstructorParameters<typeof Agent>[0]) => new Agent(options)
    )
    const internal = createInternalApiFetch(mtlsEnv(server.baseUrl), {
      createAgent,
      log: captureLog().log,
    })
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => internal(`${server.baseUrl}/health`))
    )
    expect(responses.every((response) => response.status === 200)).toBe(true)
    expect(createAgent).toHaveBeenCalledTimes(1)
    expect(createAgent.mock.calls[0]?.[0]).toMatchObject({ connect: { minVersion: 'TLSv1.3' } })
  })

  it('⚠️ Set-Cookie: login → refresh → logout round-trips over the mTLS hop', async () => {
    const server = await mtlsServer()
    const internal = createInternalApiFetch(mtlsEnv(server.baseUrl), { log: captureLog().log })
    const login = await proxyApiRequest({
      fetchFn: internal,
      request: new Request('http://web.test/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'user@invalid' }),
      }),
      path: 'auth/login',
      apiBaseUrl: server.baseUrl,
    })
    expect(login.headers.getSetCookie()).toEqual([
      'session=S1; Path=/; HttpOnly',
      'refresh-token=R1; Path=/; HttpOnly',
    ])

    const forwarded: string[] = []
    const auth = await resolveAuthContext({
      fetchFn: createServerApiFetch({ apiBaseUrl: server.baseUrl, fetchFn: internal }),
      cookieHeader: 'session=S1; refresh-token=R1',
      forwardSetCookie: (value) => forwarded.push(value),
    })
    expect(auth.status).toBe('authenticated')
    expect(forwarded).toEqual(['session=S2; Path=/; HttpOnly'])

    const logout = await proxyApiRequest({
      fetchFn: internal,
      request: new Request('http://web.test/api/v1/auth/logout', { method: 'POST', body: '{}' }),
      path: 'auth/logout',
      apiBaseUrl: server.baseUrl,
    })
    expect(logout.headers.getSetCookie()).toEqual(['session=; Path=/; Max-Age=0'])
  })
})

describe('Story 43.16 AC-9 / AC-14: web internal TLS logging', () => {
  it('logs one line on first use with the mode and the client cert notAfter, no secret material', async () => {
    const server = await mtlsServer()
    const { lines, log } = captureLog()
    const internal = createInternalApiFetch(mtlsEnv(server.baseUrl), { log })
    await Promise.all([internal(`${server.baseUrl}/health`), internal(`${server.baseUrl}/health`)])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ eventType: 'internal_tls.configured', internalTls: 'mtls' })
    expect(lines[0]?.clientCertNotAfter).toBe(
      new Date(new X509Certificate(pki.client.certPem).validTo).toISOString()
    )
    const raw = JSON.stringify(lines)
    expect(raw).not.toContain('-----BEGIN')
    for (const value of [pki.client.certB64, pki.client.keyB64, pki.ca.certB64])
      expect(raw).not.toContain(value)
  })

  it('reports tls (CA only) and off modes', async () => {
    const tls = captureLog()
    await createInternalApiFetch(
      { API_BASE_URL: 'https://localhost:1', API_TLS_CA_B64: pki.ca.certB64 },
      { baseFetch: vi.fn(async () => new Response('ok')), log: tls.log }
    )('https://localhost:1/x')
    expect(tls.lines[0]).toMatchObject({ internalTls: 'tls', clientCertNotAfter: null })
    const off = captureLog()
    await createInternalApiFetch(
      { API_BASE_URL: 'http://api:3000' },
      { baseFetch: vi.fn(async () => new Response('ok')), log: off.log }
    )('http://api:3000/x')
    expect(off.lines[0]).toMatchObject({ internalTls: 'off' })
  })

  it('warns under 30 days at first use and then at most once per 24 h', async () => {
    let now = Date.now()
    const { lines, log } = captureLog()
    const internal = createInternalApiFetch(mtlsEnv('https://localhost:1', tenDayClient), {
      baseFetch: vi.fn(async () => new Response('ok')),
      log,
      clock: () => now,
    })
    await internal('https://localhost:1/a')
    await internal('https://localhost:1/b')
    now += 23 * 3_600_000
    await internal('https://localhost:1/c')
    now += 2 * 3_600_000
    await internal('https://localhost:1/d')
    const warns = lines.filter((line) => line.eventType === 'internal_tls.cert_expiring')
    expect(warns).toHaveLength(2)
    expect(warns[0]?.level).toBe('warn')
    expect(Math.abs(Number(warns[0]?.daysRemaining) - 10)).toBeLessThanOrEqual(1)
  })
})
