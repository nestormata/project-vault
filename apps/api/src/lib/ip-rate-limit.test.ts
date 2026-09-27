import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OperationalEvent } from '@project-vault/shared'
import type { FastifyApp } from './fastify-app.js'
import { createExceededLogDeduper, registerIpRateLimit } from './ip-rate-limit.js'
import { resolveTrustProxy } from './trust-proxy.js'

const MESSAGE = 'Too many authentication attempts'
const EVENT = OperationalEvent.AUTH_CLI_RATE_LIMITED
const SENTINEL_EMAIL = 'sentinel-victim@example.com'
const SENTINEL_PASSWORD = 'sentinel-password-value'
const IP_A = '198.51.100.7'

type Harness = { app: FastifyInstance; logLines: Record<string, unknown>[] }

async function buildApp(
  options: {
    max?: number
    trustProxy?: ReturnType<typeof resolveTrustProxy>
    beforeRegister?: (app: FastifyInstance) => void
  } = {}
): Promise<Harness> {
  const logLines: Record<string, unknown>[] = []
  const app = Fastify({
    trustProxy: options.trustProxy ?? false,
    logger: {
      level: 'warn',
      stream: { write: (line: string) => logLines.push(JSON.parse(line)) },
    },
  })
  // Mirrors app.ts's error handler: a thrown error carrying statusCode 429 + code becomes { code, message }.
  app.setErrorHandler(
    (error: { statusCode?: number; code?: string; message: string }, _req, reply) => {
      if (error.statusCode === 429 && error.code) {
        return reply.status(429).send({ code: error.code, message: error.message })
      }
      return reply.status(500).send({ code: 'internal_error', message: 'Internal Server Error' })
    }
  )
  options.beforeRegister?.(app)
  await app.register(async (scope) => {
    await registerIpRateLimit(scope as unknown as FastifyApp, {
      max: options.max ?? 3,
      message: MESSAGE,
      logEventType: EVENT,
    })
    scope.post('/x', async () => ({ ok: true }))
    scope.post('/y', { config: { rateLimit: { max: 2, timeWindow: '1 minute' } } }, async () => ({
      ok: true,
    }))
  })
  await app.ready()
  return { app, logLines }
}

function hit(
  app: FastifyInstance,
  remoteAddress: string,
  headers: Record<string, string> = {},
  url = '/x'
) {
  return app.inject({
    method: 'POST',
    url,
    remoteAddress,
    headers,
    payload: { email: SENTINEL_EMAIL, password: SENTINEL_PASSWORD },
  })
}

/** max=1: the second request is 429 iff both requests landed in the same bucket. */
async function sharesBucket(
  first: { ip: string; headers?: Record<string, string> },
  second: { ip: string; headers?: Record<string, string> },
  trustProxy: ReturnType<typeof resolveTrustProxy> = false
): Promise<boolean> {
  const { app } = await buildApp({ max: 1, trustProxy })
  try {
    expect((await hit(app, first.ip, first.headers)).statusCode).toBe(200)
    return (await hit(app, second.ip, second.headers)).statusCode === 429
  } finally {
    await app.close()
  }
}

describe('registerIpRateLimit (Story 43.8)', () => {
  afterEach(() => {
    vi.useRealTimers()
    delete process.env['RATE_LIMIT_TEST_BYPASS']
  })

  describe('AC-5: registration and the 429 contract', () => {
    it('registers @fastify/rate-limit with exactly the allowed option keys (nothing that weakens it)', async () => {
      const register = vi.fn(async () => undefined)
      await registerIpRateLimit({ register } as unknown as FastifyApp, {
        max: 7,
        message: MESSAGE,
        logEventType: EVENT,
      })
      expect(register).toHaveBeenCalledTimes(1)
      const opts = (register.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1]
      expect(Object.keys(opts).sort()).toEqual([
        'errorResponseBuilder',
        'max',
        'onExceeded',
        'timeWindow',
      ])
      expect(opts['max']).toBe(7)
      expect(opts['timeWindow']).toBe('1 minute')
    })

    it('is a no-op when NODE_ENV=test and RATE_LIMIT_TEST_BYPASS=true', async () => {
      process.env['RATE_LIMIT_TEST_BYPASS'] = 'true'
      const register = vi.fn(async () => undefined)
      await registerIpRateLimit({ register } as unknown as FastifyApp, {
        max: 1,
        message: MESSAGE,
        logEventType: EVENT,
      })
      expect(register).not.toHaveBeenCalled()
    })

    it('allows exactly max requests, then returns the documented 429 (never a 500)', async () => {
      const { app } = await buildApp({ max: 5 })
      try {
        const responses = []
        for (let i = 0; i < 6; i += 1) responses.push(await hit(app, IP_A))
        expect(responses.slice(0, 5).map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200])
        expect(responses[0]?.headers['x-ratelimit-limit']).toBe('5')
        expect(responses[0]?.headers['x-ratelimit-remaining']).toBe('4')
        const limited = responses[5]
        expect(limited?.statusCode).toBe(429)
        expect(limited?.json()).toStrictEqual({ code: 'rate_limit_exceeded', message: MESSAGE })
        expect(limited?.headers['x-ratelimit-remaining']).toBe('0')
        const retryAfter = String(limited?.headers['retry-after'])
        expect(retryAfter).toMatch(/^\d+$/)
        expect(Number(retryAfter)).toBeGreaterThanOrEqual(1)
        expect(Number(retryAfter)).toBeLessThanOrEqual(60)
      } finally {
        await app.close()
      }
    })

    it('AC-2: the window resets after one minute and the counter restarts', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const { app } = await buildApp({ max: 2 })
      try {
        await hit(app, IP_A)
        await hit(app, IP_A)
        expect((await hit(app, IP_A)).statusCode).toBe(429)
        vi.advanceTimersByTime(60_001)
        const afterReset = await hit(app, IP_A)
        expect(afterReset.statusCode).toBe(200)
        expect(afterReset.headers['x-ratelimit-remaining']).toBe('1')
      } finally {
        await app.close()
      }
    })

    it('a per-route config.rateLimit override gets its own independent bucket', async () => {
      const { app } = await buildApp({ max: 1 })
      try {
        expect((await hit(app, IP_A)).statusCode).toBe(200)
        expect((await hit(app, IP_A)).statusCode).toBe(429)
        expect((await hit(app, IP_A, {}, '/y')).statusCode).toBe(200)
        expect((await hit(app, IP_A, {}, '/y')).statusCode).toBe(200)
        expect((await hit(app, IP_A, {}, '/y')).statusCode).toBe(429)
      } finally {
        await app.close()
      }
    })
  })

  describe('AC-4: key normalization and proxy handling', () => {
    it('TRUST_PROXY=false: X-Forwarded-For / X-Real-IP never create new buckets', async () => {
      expect(
        await sharesBucket(
          {
            ip: IP_A,
            headers: { 'x-forwarded-for': '10.0.0.1', 'x-real-ip': '10.0.1.1' },
          },
          {
            ip: IP_A,
            headers: { 'x-forwarded-for': '10.0.0.2', 'x-real-ip': '10.0.1.2' },
          }
        )
      ).toBe(true)
    })

    it('TRUST_PROXY=true, hops=1: two real clients behind one proxy are separate buckets', async () => {
      expect(
        await sharesBucket(
          { ip: '10.0.0.2', headers: { 'x-forwarded-for': '192.0.2.1' } },
          { ip: '10.0.0.2', headers: { 'x-forwarded-for': '192.0.2.2' } },
          resolveTrustProxy(true, 1)
        )
      ).toBe(false)
    })

    it('TRUST_PROXY=true, hops=1: attacker-prepended XFF entries are ignored', async () => {
      expect(
        await sharesBucket(
          { ip: '10.0.0.2', headers: { 'x-forwarded-for': '1.1.1.1, 192.0.2.1' } },
          { ip: '10.0.0.2', headers: { 'x-forwarded-for': '2.2.2.2, 192.0.2.1' } },
          resolveTrustProxy(true, 1)
        )
      ).toBe(true)
    })

    it('operator contract: TRUST_PROXY_HOPS too high (2 with one real proxy) lets the client pick its key', async () => {
      // Documented, not prevented (docs/configuration.md TRUST_PROXY_HOPS): an over-counted hop
      // makes the attacker-chosen left entry `req.ip`, so each spoofed value is a fresh bucket.
      expect(
        await sharesBucket(
          { ip: '10.0.0.2', headers: { 'x-forwarded-for': '6.6.6.1, 192.0.2.1' } },
          { ip: '10.0.0.2', headers: { 'x-forwarded-for': '6.6.6.2, 192.0.2.1' } },
          resolveTrustProxy(true, 2)
        )
      ).toBe(false)
    })

    it('IPv6: addresses inside one /64 share a bucket', async () => {
      expect(
        await sharesBucket(
          { ip: '2001:db8:abcd:12::1' },
          { ip: '2001:db8:abcd:12:ffff:ffff:ffff:fffe' }
        )
      ).toBe(true)
    })

    it('IPv6: a different /64 is a different bucket', async () => {
      expect(await sharesBucket({ ip: '2001:db8:abcd:12::1' }, { ip: '2001:db8:abcd:13::1' })).toBe(
        false
      )
    })

    it('IPv6: textual forms of one address share a bucket', async () => {
      expect(await sharesBucket({ ip: '2001:DB8::1' }, { ip: '2001:db8:0:0:0:0:0:1' })).toBe(true)
    })

    it('IPv4-mapped IPv6 shares the bucket of the plain IPv4 address', async () => {
      expect(await sharesBucket({ ip: '::ffff:198.51.100.7' }, { ip: IP_A })).toBe(true)
    })

    it('IPv4: neighbouring addresses are different buckets (no IPv4 subnet grouping)', async () => {
      expect(await sharesBucket({ ip: IP_A }, { ip: '198.51.100.8' })).toBe(false)
    })
  })

  describe('AC-6: deduplicated, secret-free over-limit logging', () => {
    function rateLimitLines(lines: Record<string, unknown>[]) {
      return lines.filter((line) => line['eventType'] === EVENT)
    }

    it('logs exactly once per (route, key, window) no matter how many 429s follow', async () => {
      const { app, logLines } = await buildApp({ max: 3 })
      try {
        for (let i = 0; i < 10; i += 1) await hit(app, IP_A)
        const lines = rateLimitLines(logLines)
        expect(lines).toHaveLength(1)
        expect(lines[0]).toMatchObject({
          eventType: EVENT,
          route: '/x',
          method: 'POST',
          ipKey: IP_A,
          limit: 3,
          msg: 'CLI auth rate limit exceeded',
        })
      } finally {
        await app.close()
      }
    })

    it('never logs the body, credentials or auth headers', async () => {
      const { app, logLines } = await buildApp({ max: 1 })
      try {
        for (let i = 0; i < 3; i += 1) {
          await hit(app, IP_A, {
            authorization: 'Bearer sentinel-token',
            cookie: 'a=sentinel-cookie',
          })
        }
        const serialized = JSON.stringify(rateLimitLines(logLines))
        expect(serialized).not.toContain(SENTINEL_EMAIL)
        expect(serialized).not.toContain(SENTINEL_PASSWORD)
        expect(serialized).not.toContain('sentinel-token')
        expect(serialized).not.toContain('sentinel-cookie')
      } finally {
        await app.close()
      }
    })

    it('logs again once a new window is exceeded, and once per IP', async () => {
      vi.useFakeTimers({ toFake: ['Date'] })
      const { app, logLines } = await buildApp({ max: 1 })
      try {
        for (let i = 0; i < 3; i += 1) await hit(app, IP_A)
        for (let i = 0; i < 3; i += 1) await hit(app, '203.0.113.9')
        expect(rateLimitLines(logLines)).toHaveLength(2)
        vi.advanceTimersByTime(60_001)
        for (let i = 0; i < 3; i += 1) await hit(app, IP_A)
        expect(rateLimitLines(logLines)).toHaveLength(3)
      } finally {
        await app.close()
      }
    })

    it('a throwing logger never turns the 429 into a 500', async () => {
      const { app } = await buildApp({
        max: 1,
        beforeRegister: (instance) => {
          instance.addHook('onRequest', async (req) => {
            req.log.warn = () => {
              throw new Error('logger exploded')
            }
          })
        },
      })
      try {
        await hit(app, IP_A)
        const limited = await hit(app, IP_A)
        expect(limited.statusCode).toBe(429)
        expect(limited.json()).toStrictEqual({ code: 'rate_limit_exceeded', message: MESSAGE })
      } finally {
        await app.close()
      }
    })
  })

  describe('createExceededLogDeduper', () => {
    it('returns true once per key until its window ends', () => {
      const deduper = createExceededLogDeduper(10)
      expect(deduper.shouldLog('a', 1_000, 61_000)).toBe(true)
      expect(deduper.shouldLog('a', 30_000, 61_000)).toBe(false)
      expect(deduper.shouldLog('b', 30_000, 90_000)).toBe(true)
      expect(deduper.shouldLog('a', 61_000, 121_000)).toBe(true)
    })

    it('is bounded: oldest entries are evicted beyond the cap', () => {
      const deduper = createExceededLogDeduper(3)
      for (const key of ['a', 'b', 'c', 'd']) expect(deduper.shouldLog(key, 0, 60_000)).toBe(true)
      expect(deduper.size()).toBe(3)
      // 'a' was evicted, so it logs again (bounded memory beats perfect dedupe under spraying).
      expect(deduper.shouldLog('a', 1, 60_000)).toBe(true)
      expect(deduper.shouldLog('d', 1, 60_000)).toBe(false)
      expect(deduper.size()).toBe(3)
    })
  })
})
