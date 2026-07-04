import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import {
  endpointHealthChecks,
  monitoringAlerts,
  notificationPreferences,
  serviceEndpoints,
} from '@project-vault/db/schema'
import { insertTestProject } from '@project-vault/db/test-helpers'
import {
  configureAuthIntegrationEnv,
  initVaultForTest,
} from '../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../__tests__/helpers/vault-test-cleanup.js'
import { createMockBoss } from '../__tests__/helpers/notification-test-helpers.js'
import { withExpiryAlertTestOrg, queueEntriesForTemplate } from './expiry-alert-test-helpers.js'
import {
  probeServiceEndpoint,
  runHealthCheckTick,
  runWithConcurrencyLimit,
} from './monitoring-health-check.js'

function jsonResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers })
}

const HEALTH_URL = 'https://api.example.com/health'
const SERVICE_DOWN = 'service.down'
const SERVICE_RECOVERY = 'service.recovery'

// AC 14: a service.down/service.recovery alert writes a system-initiated audit row, which
// requires a real (unsealed) audit HMAC key — unlike the 6.1 expiry-alert workers (which never
// call getAuditKey()), this is the first worker suite to exercise that path outside a full
// app+vault bootstrap.
beforeAll(async () => {
  configureAuthIntegrationEnv()
  await resetVaultForTest()
  const { initVault } = await import('../modules/vault/key-service.js')
  await initVaultForTest(initVault, 'monitoring-health-check-test-passphrase')
})

afterAll(async () => {
  await resetVaultForTest()
})

describe('probeServiceEndpoint (AC 4, ADR-6.2-08)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('classifies a 2xx response as healthy', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200))
    const result = await probeServiceEndpoint(HEALTH_URL, {} as never)
    expect(result).toMatchObject({ isHealthy: true, statusCode: 200, failureReason: null })
  })

  it('classifies a non-2xx response as http_error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(503))
    const result = await probeServiceEndpoint(HEALTH_URL, {} as never)
    expect(result).toMatchObject({ isHealthy: false, statusCode: 503, failureReason: 'http_error' })
  })

  it('follows a redirect chain terminating in a final 2xx (healthy)', async () => {
    // Literal public IPs everywhere (including the redirect target) so assertUrlIsMonitorable's
    // re-validation of the redirect hop needs no real DNS lookup — deterministic in CI/sandboxes.
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(301, { location: 'https://93.184.216.1/health2' }))
      .mockResolvedValueOnce(jsonResponse(200))
    const result = await probeServiceEndpoint('http://93.184.216.1/health', {} as never)
    expect(result).toMatchObject({ isHealthy: true, statusCode: 200, failureReason: null })
  })

  it('blocks a redirect landing on a private/metadata address (ssrf_blocked)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse(302, { location: 'http://169.254.169.254/latest/meta-data/' })
    )
    const result = await probeServiceEndpoint(HEALTH_URL, {} as never)
    expect(result).toMatchObject({
      isHealthy: false,
      statusCode: null,
      failureReason: 'ssrf_blocked',
    })
  })

  it('fails a redirect chain exceeding 5 hops', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    for (let i = 0; i < 6; i++) {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(302, { location: `https://93.184.216.1/hop${i}` })
      )
    }
    const result = await probeServiceEndpoint('https://93.184.216.1/start', {} as never)
    expect(result).toMatchObject({
      isHealthy: false,
      statusCode: null,
      failureReason: 'network_error',
    })
  })

  it('classifies a timeout as failureReason "timeout"', async () => {
    vi.useFakeTimers()
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          const signal = (options as { signal?: AbortSignal } | undefined)?.signal
          signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          })
        })
    )
    const resultPromise = probeServiceEndpoint('https://slow.example.com/health', {} as never)
    await vi.advanceTimersByTimeAsync(10_000)
    const result = await resultPromise
    expect(result).toMatchObject({ isHealthy: false, statusCode: null, failureReason: 'timeout' })
  })

  it('classifies a generic network error as failureReason "network_error"', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
    const result = await probeServiceEndpoint('https://down.example.com/health', {} as never)
    expect(result).toMatchObject({
      isHealthy: false,
      statusCode: null,
      failureReason: 'network_error',
    })
  })

  it('classifies a dispatcher connect-time SSRF block (DNS rebinding) as ssrf_blocked', async () => {
    const { UrlNotMonitorableError } = await import('../modules/monitoring/service.js')
    const fetchError = Object.assign(new TypeError('fetch failed'), {
      cause: new UrlNotMonitorableError(),
    })
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(fetchError)
    const result = await probeServiceEndpoint('https://rebind.example.com/health', {} as never)
    expect(result).toMatchObject({
      isHealthy: false,
      statusCode: null,
      failureReason: 'ssrf_blocked',
    })
  })
})

describe('runWithConcurrencyLimit', () => {
  it('processes every item and never exceeds the concurrency limit', async () => {
    const items = Array.from({ length: 10 }, (_, i) => i)
    let active = 0
    let maxActive = 0
    const processed: number[] = []

    await runWithConcurrencyLimit(items, 3, async (item) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      processed.push(item)
      active--
    })

    expect(processed.sort((a, b) => a - b)).toEqual(items)
    expect(maxActive).toBeLessThanOrEqual(3)
  })
})

describe('runHealthCheckTick (AC 4-8, 16 — DB integration)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function seedEndpoint(
    orgId: string,
    projectId: string,
    overrides: Partial<typeof serviceEndpoints.$inferInsert> = {}
  ) {
    const [row] = await withOrg(orgId, (tx) =>
      tx
        .insert(serviceEndpoints)
        .values({
          orgId,
          projectId,
          name: 'Test endpoint',
          url: HEALTH_URL,
          ...overrides,
        })
        .returning()
    )
    if (!row) throw new Error('expected service endpoint to be inserted')
    return row
  }

  async function fetchEndpoint(orgId: string, id: string) {
    const [row] = await withOrg(orgId, (tx) =>
      tx.select().from(serviceEndpoints).where(eq(serviceEndpoints.id, id))
    )
    return row
  }

  async function healthChecksFor(orgId: string, serviceEndpointId: string) {
    return withOrg(orgId, (tx) =>
      tx
        .select()
        .from(endpointHealthChecks)
        .where(eq(endpointHealthChecks.serviceEndpointId, serviceEndpointId))
    )
  }

  async function alertsFor(orgId: string, serviceEndpointId: string) {
    return withOrg(orgId, (tx) =>
      tx
        .select()
        .from(monitoringAlerts)
        .where(eq(monitoringAlerts.serviceEndpointId, serviceEndpointId))
    )
  }

  /**
   * The real due-query (its own dedicated test below) only re-checks an endpoint once
   * `checkFrequencyMinutes` has elapsed since `lastCheckedAt` — which the previous tick in
   * these status-transition tests just set to "now". Simulating N consecutive checks in a single
   * fast test therefore requires forcing the endpoint due again between ticks (due-query timing
   * itself is not what these tests are exercising).
   */
  async function forceDue(orgId: string, id: string): Promise<void> {
    await withOrg(orgId, (tx) =>
      tx.update(serviceEndpoints).set({ lastCheckedAt: null }).where(eq(serviceEndpoints.id, id))
    )
  }

  it('records a healthy check and keeps status healthy', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200))
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('health-check-healthy', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, { userId: ownerId, slug: 'hc-healthy' })
      const endpoint = await seedEndpoint(orgId, project.id, { lastCheckedAt: null })

      await runHealthCheckTick(boss)

      const checks = await healthChecksFor(orgId, endpoint.id)
      expect(checks).toHaveLength(1)
      expect(checks[0]).toMatchObject({ isHealthy: true, statusCode: 200, failureReason: null })

      const updated = await fetchEndpoint(orgId, endpoint.id)
      expect(updated?.status).toBe('healthy')
      expect(updated?.consecutiveFailures).toBe(0)
      expect(updated?.lastCheckedAt).not.toBeNull()
    })
  }, 20_000)

  it('is degraded for every consecutiveFailures value strictly between 1 and downThresholdFailures when threshold > 2 (adversarial-review finding 4)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(503))
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('health-check-degraded', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, { userId: ownerId, slug: 'hc-degraded' })
      const endpoint = await seedEndpoint(orgId, project.id, {
        downThresholdFailures: 5,
        lastCheckedAt: null,
      })

      for (let i = 1; i <= 4; i++) {
        if (i > 1) await forceDue(orgId, endpoint.id)
        await runHealthCheckTick(boss)
        const updated = await fetchEndpoint(orgId, endpoint.id)
        expect(updated?.consecutiveFailures).toBe(i)
        expect(updated?.status).toBe('degraded')
      }

      const alertsBeforeDown = await alertsFor(orgId, endpoint.id)
      expect(alertsBeforeDown).toHaveLength(0)
    })
  }, 30_000)

  it('fires exactly one service.down alert/notification on crossing the threshold, no duplicate on repeat down checks (AC 5)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(503))
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('health-check-down', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, { userId: ownerId, slug: 'hc-down' })
      const endpoint = await seedEndpoint(orgId, project.id, {
        downThresholdFailures: 2,
        lastCheckedAt: null,
      })

      await runHealthCheckTick(boss) // consecutiveFailures 0 -> 1 (degraded)
      await forceDue(orgId, endpoint.id)
      await runHealthCheckTick(boss) // consecutiveFailures 1 -> 2 (down, alert fires)

      const updated = await fetchEndpoint(orgId, endpoint.id)
      expect(updated?.status).toBe('down')

      const alerts = await alertsFor(orgId, endpoint.id)
      expect(alerts).toHaveLength(1)
      expect(alerts[0]).toMatchObject({ alertType: SERVICE_DOWN, severity: 'critical' })

      const queueEntries = await queueEntriesForTemplate(orgId, SERVICE_DOWN)
      expect(queueEntries.length).toBeGreaterThan(0)

      // Same episode: further still-down checks must not create a second alert.
      await forceDue(orgId, endpoint.id)
      await runHealthCheckTick(boss)
      await forceDue(orgId, endpoint.id)
      await runHealthCheckTick(boss)
      const alertsAfterMore = await alertsFor(orgId, endpoint.id)
      expect(alertsAfterMore).toHaveLength(1)
    })
  }, 30_000)

  it("fires a service.recovery alert when a down endpoint's next check succeeds (AC 6)", async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('health-check-recovery', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, { userId: ownerId, slug: 'hc-recovery' })
      const endpoint = await seedEndpoint(orgId, project.id, {
        downThresholdFailures: 2,
        lastCheckedAt: null,
      })
      // service.recovery fires at severity 'info' (AC 6 — "good news, not a critical page"),
      // below the org-wide default min-severity of 'warning' (see DEFAULT_NOTIFICATION_MIN_
      // SEVERITY). Lower this owner's preference so the fan-out is actually observable in the
      // queue, exactly as an org admin who wants recovery notices would configure it.
      await withOrg(orgId, (tx) =>
        tx.insert(notificationPreferences).values({
          orgId,
          userId: ownerId,
          alertType: SERVICE_RECOVERY,
          channel: 'inbox',
          minSeverity: 'info',
        })
      )

      fetchMock.mockResolvedValue(jsonResponse(503))
      await runHealthCheckTick(boss)
      await forceDue(orgId, endpoint.id)
      await runHealthCheckTick(boss) // now down, one service.down alert

      fetchMock.mockResolvedValue(jsonResponse(200))
      await forceDue(orgId, endpoint.id)
      await runHealthCheckTick(boss)

      const updated = await fetchEndpoint(orgId, endpoint.id)
      expect(updated?.status).toBe('healthy')
      expect(updated?.consecutiveFailures).toBe(0)

      const alerts = await alertsFor(orgId, endpoint.id)
      expect(alerts.map((a) => a.alertType).sort()).toEqual([SERVICE_DOWN, SERVICE_RECOVERY])

      const recoveryQueueEntries = await queueEntriesForTemplate(orgId, SERVICE_RECOVERY)
      expect(recoveryQueueEntries.length).toBeGreaterThan(0)
    })
  }, 30_000)

  it('honors per-endpoint checkFrequencyMinutes: a recently-checked endpoint is not due', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(200))
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('health-check-due-query', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, { userId: ownerId, slug: 'hc-due' })
      const notDueEndpoint = await seedEndpoint(orgId, project.id, {
        name: 'not due',
        checkFrequencyMinutes: 30,
        lastCheckedAt: new Date(Date.now() - 2 * 60_000), // 2 minutes ago, due every 30 min
      })
      const dueEndpoint = await seedEndpoint(orgId, project.id, {
        name: 'due',
        checkFrequencyMinutes: 5,
        lastCheckedAt: new Date(Date.now() - 6 * 60_000), // 6 minutes ago, due every 5 min
      })

      await runHealthCheckTick(boss)

      expect(await healthChecksFor(orgId, notDueEndpoint.id)).toHaveLength(0)
      expect(await healthChecksFor(orgId, dueEndpoint.id)).toHaveLength(1)
      void fetchMock
    })
  }, 20_000)

  it('a second concurrent tick invocation is skipped while the first still holds the advisory lock (ADR-6.2-09)', async () => {
    let resolveFirstFetch: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      resolveFirstFetch = resolve
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await gate
      return jsonResponse(200)
    })
    const { boss } = createMockBoss()
    await boss.start()

    await withExpiryAlertTestOrg('health-check-overlap', async ({ orgId, ownerId }) => {
      const project = await insertTestProject(orgId, { userId: ownerId, slug: 'hc-overlap' })
      const endpoint = await seedEndpoint(orgId, project.id, { lastCheckedAt: null })

      const firstTick = runHealthCheckTick(boss)
      // Give the first tick a moment to acquire the advisory lock before starting the second.
      await new Promise((resolve) => setTimeout(resolve, 50))
      const secondTick = runHealthCheckTick(boss)

      resolveFirstFetch?.()
      await Promise.all([firstTick, secondTick])

      // Only the first tick's probe should have recorded a check for this endpoint.
      const checks = await healthChecksFor(orgId, endpoint.id)
      expect(checks).toHaveLength(1)
    })
  }, 20_000)
})
