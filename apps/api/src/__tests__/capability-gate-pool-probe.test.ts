import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { CapabilityId } from '@project-vault/shared'
import type { CapabilityDecision } from '@project-vault/extension-api'
import {
  __resetCapabilityGateForTests,
  assertCapability,
  wireExtensionCapabilityGate,
} from '../lib/capability-gate.js'
import { secureRoute, type SecureRouteRegistrationOptions } from '../lib/secure-route.js'

/**
 * Story 23.3 AC-19 — "the gate is never awaited inside an open database transaction, proven by a
 * pool probe." This is the *normative* test: not a `db.transaction` call-order spy (an
 * acceptable *additional* signal per the AC, but explicitly "not sufficient on its own"), but a
 * real Postgres pool with `max: 1`. If the code under test held a connection while the gate is
 * pending, a concurrent query against that same single-connection pool would have to wait for the
 * gate to release it — this test proves that concurrent query is NOT blocked.
 *
 * Requires a real, reachable Postgres via `DATABASE_URL` (`make db-up` + a migrated schema) —
 * skipped automatically if `DATABASE_URL` is unset, matching this repo's other opt-in
 * DB-backed unit tests.
 */
const TEST_APIVERSION = '1.3.0'
const TEST_EXTENSION_NAME = 'com.example.ext'
const TEST_ORG_ID = ['00000000', '0000', '4000', '8000', '000000000001'].join('-')
const DATABASE_URL = process.env['DATABASE_URL']
const describeIfDb = DATABASE_URL ? describe : describe.skip

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** Races a probe query against a short timeout — resolves 'ok' if fast, 'blocked' if not. */
async function probeSingleConnectionPool(
  sql: postgres.Sql,
  timeoutMs = 800
): Promise<'ok' | 'blocked'> {
  return Promise.race([
    sql`select 1`.then(() => 'ok' as const),
    new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), timeoutMs)),
  ])
}

describeIfDb('capability gate — pool-checkout probe (AC-19, the normative assertion)', () => {
  const sql = postgres(DATABASE_URL as string, { max: 1 })
  const db = drizzle(sql)

  afterEach(() => __resetCapabilityGateForTests())
  afterAll(async () => {
    await sql.end({ timeout: 5 })
  })

  it('declarative form: while the gate is pending, the route holds NO pooled connection — a concurrent query on the same max:1 pool is served normally', async () => {
    const gateReleased = deferred<CapabilityDecision>()
    wireExtensionCapabilityGate({
      status: 'loaded',
      manifest: { name: TEST_EXTENSION_NAME, apiVersion: TEST_APIVERSION, capabilities: [] },
      loadedAt: new Date().toISOString(),
      hooks: { capabilityGate: { onCheckCapability: () => gateReleased.promise } },
    })

    const route = vi.fn()
    const fastifyStub = {
      authenticate: async (req: { authContext?: unknown }) => {
        req.authContext = {
          userId: 'user-1',
          orgId: TEST_ORG_ID,
          sessionId: 's1',
          jti: 'j1',
          sessionVersion: 1,
          orgRole: 'admin',
        }
      },
      route,
      withTypeProvider: () => ({ route }),
    }
    const options: SecureRouteRegistrationOptions = {
      method: 'POST',
      url: '/api/v1/test/pool-probe',
      security: {
        capability: CapabilityId.MONITORING_PUBLIC_STATUS_PAGE,
        requireOrgScope: true,
        writeAuditEvent: false,
      },
      db,
      handler: async () => ({ ok: true }),
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fastify stub
    secureRoute(fastifyStub as any, options)
    const registered = route.mock.calls[0]?.[0] as {
      preHandler: Array<(req: unknown, reply: unknown) => Promise<unknown>>
      handler: (req: unknown, reply: unknown) => Promise<unknown>
    }

    const req: Record<string, unknown> = {
      id: 'req-1',
      log: { error: () => undefined, warn: () => undefined },
    }
    const reply = {
      sent: false,
      statusCode: 200,
      status(code: number) {
        this.statusCode = code
        return this
      },
      send(body: unknown) {
        this.sent = true
        return body
      },
    }

    for (const preHandler of registered.preHandler) await preHandler(req, reply)
    const requestPromise = registered.handler(req, reply)

    // Give the request a moment to reach (and start awaiting) the gate.
    await new Promise((resolve) => setTimeout(resolve, 50))

    const probeResult = await probeSingleConnectionPool(sql)
    expect(probeResult).toBe('ok')

    gateReleased.resolve({ permitted: true })
    await requestPromise
  })

  it('imperative form (assertCapability): while pending, no pooled connection is held — a concurrent query on the same max:1 pool is served normally', async () => {
    const gateReleased = deferred<CapabilityDecision>()
    wireExtensionCapabilityGate({
      status: 'loaded',
      manifest: { name: TEST_EXTENSION_NAME, apiVersion: TEST_APIVERSION, capabilities: [] },
      loadedAt: new Date().toISOString(),
      hooks: { capabilityGate: { onCheckCapability: () => gateReleased.promise } },
    })

    const assertPromise = assertCapability({
      capability: CapabilityId.MONITORING_PUBLIC_STATUS_PAGE,
      orgId: null,
      userId: null,
      orgRole: null,
      surface: 'public',
    })

    await new Promise((resolve) => setTimeout(resolve, 50))
    const probeResult = await probeSingleConnectionPool(sql)
    expect(probeResult).toBe('ok')

    gateReleased.resolve({ permitted: true })
    await assertPromise
  })

  it('the probe has teeth: calling assertCapability() from INSIDE an open transaction on the same max:1 pool DOES block the concurrent probe query', async () => {
    const gateReleased = deferred<CapabilityDecision>()
    wireExtensionCapabilityGate({
      status: 'loaded',
      manifest: { name: TEST_EXTENSION_NAME, apiVersion: TEST_APIVERSION, capabilities: [] },
      loadedAt: new Date().toISOString(),
      hooks: { capabilityGate: { onCheckCapability: () => gateReleased.promise } },
    })

    let probeResult: 'ok' | 'blocked' | undefined
    const txPromise = db.transaction(async () => {
      // Incorrect arrangement (what AC-10/AC-19 forbid): assertCapability() called from inside an
      // already-open transaction on the pool's only connection.
      const inTxAssert = assertCapability({
        capability: CapabilityId.MONITORING_PUBLIC_STATUS_PAGE,
        orgId: null,
        userId: null,
        orgRole: null,
        surface: 'public',
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      probeResult = await probeSingleConnectionPool(sql, 300)
      gateReleased.resolve({ permitted: true })
      await inTxAssert
    })

    await txPromise
    expect(probeResult).toBe('blocked')
  })
})
