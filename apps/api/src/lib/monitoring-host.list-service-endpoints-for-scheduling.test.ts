import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionManifest } from '@project-vault/extension-api'
import { MonitoringRateLimitedError } from '@project-vault/extension-api'

/**
 * Story 57.1 — unit coverage for `listServiceEndpointsForScheduling`, mirroring
 * `monitoring-host.create-service-endpoint.test.ts`'s own `withOrg`/service-layer-mocking
 * precedent so this closure's own control flow (AC2 raw-URL passthrough, AC3 no-ambient-context
 * requirement, AC6 rate-limiting/audit-logging, the AC1 empty-org edge case, and the
 * no-wholesale-row-spread regression guard) is isolated from a live database. Real-Postgres
 * cross-tenant proof (AC5) lives in `monitoring-host.integration.test.ts`.
 */

const { withOrg } = vi.hoisted(() => ({ withOrg: vi.fn() }))
vi.mock('@project-vault/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@project-vault/db')>()
  return { ...actual, withOrg }
})

const { listServiceEndpointsForOrg } = vi.hoisted(() => ({
  listServiceEndpointsForOrg: vi.fn(),
}))
vi.mock('../modules/monitoring/service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../modules/monitoring/service.js')>()
  return { ...actual, listServiceEndpointsForOrg }
})

const { buildMonitoringHost, __resetMonitoringHostRateLimitForTests } =
  await import('./monitoring-host.js')

// Test-fixture UUID, not a secret.
/* eslint-disable no-secrets/no-secrets */
const ORG_ID = '11111111-1111-1111-1111-111111111111'
/* eslint-enable no-secrets/no-secrets */

const MANIFEST: ExtensionManifest = {
  name: 'com.acme.list-service-endpoints-fixture',
  apiVersion: '3.19.0',
  capabilities: [],
}

const FAKE_TX = { __fakeTx: true }

const RAW_ROW = {
  id: 'endpoint-1',
  orgId: ORG_ID,
  projectId: 'project-1',
  name: 'API health',
  // Secret-shaped query param, deliberately — must come back unmodified (AC2).

  url: 'https://api.example.com/health?api_key=secret123',

  checkFrequencyMinutes: 5,
  healthCheckPausedAt: null,
  consecutiveFailures: 0,
  status: 'healthy',
  lastCheckedAt: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  withOrg.mockImplementation(async (_orgId: string, fn: (tx: unknown) => unknown) => fn(FAKE_TX))
  listServiceEndpointsForOrg.mockResolvedValue([RAW_ROW])
})

afterEach(() => {
  __resetMonitoringHostRateLimitForTests()
  vi.restoreAllMocks()
})

describe('buildMonitoringHost.listServiceEndpointsForScheduling (Story 57.1)', () => {
  it('AC2: returns the raw, unredacted url exactly as the service layer returns it', async () => {
    const host = buildMonitoringHost(MANIFEST)
    const result = await host.listServiceEndpointsForScheduling({ organizationId: ORG_ID })

    expect(result).toEqual([RAW_ROW])
    expect(listServiceEndpointsForOrg).toHaveBeenCalledWith(FAKE_TX, ORG_ID)
  })

  it('AC3: succeeds with no ambient request context bound at all', async () => {
    const host = buildMonitoringHost(MANIFEST)
    // Deliberately not wrapped in runWithRequestContext — this method must never call
    // requireAmbientOrgId()/getRequestContext().
    await expect(
      host.listServiceEndpointsForScheduling({ organizationId: ORG_ID })
    ).resolves.toEqual([RAW_ROW])
  })

  it('AC1 edge case: an org with zero service endpoints returns []', async () => {
    listServiceEndpointsForOrg.mockResolvedValue([])
    const host = buildMonitoringHost(MANIFEST)
    await expect(
      host.listServiceEndpointsForScheduling({ organizationId: ORG_ID })
    ).resolves.toEqual([])
  })

  it('regression guard: each result object contains exactly the 10 whitelisted fields, no extra keys', async () => {
    const host = buildMonitoringHost(MANIFEST)
    const result = await host.listServiceEndpointsForScheduling({ organizationId: ORG_ID })
    expect(result).toHaveLength(1)
    const [row] = result

    expect(Object.keys(row ?? {}).sort()).toEqual(
      [
        'id',
        'orgId',
        'projectId',
        'name',
        'url',
        'checkFrequencyMinutes',
        'healthCheckPausedAt',
        'consecutiveFailures',
        'status',
        'lastCheckedAt',
      ].sort()
    )
  })

  it('AC6: shares the MONITORING_HOST_MAX_IN_FLIGHT_PER_EXTENSION budget and rate-limits after the cap, releasing the slot after each call', async () => {
    const host = buildMonitoringHost(MANIFEST, {}, { maxInFlight: 1 })
    let releaseFirst: (() => void) | undefined
    listServiceEndpointsForOrg.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve([RAW_ROW])
        })
    )

    const first = host.listServiceEndpointsForScheduling({ organizationId: ORG_ID })
    await expect(
      host.listServiceEndpointsForScheduling({ organizationId: ORG_ID })
    ).rejects.toBeInstanceOf(MonitoringRateLimitedError)

    releaseFirst?.()
    await expect(first).resolves.toEqual([RAW_ROW])
  })

  it('AC6: records an audit log entry with outcome "ok" on success', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }
    const host = buildMonitoringHost(MANIFEST, logger)

    await host.listServiceEndpointsForScheduling({ organizationId: ORG_ID })

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG_ID,
        extensionName: MANIFEST.name,
        method: 'listServiceEndpointsForScheduling',
        outcome: 'ok',
      }),
      expect.any(String)
    )
  })

  it('AC6: records an audit log entry with outcome "rate-limited" on denial', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }
    const host = buildMonitoringHost(MANIFEST, logger, { maxInFlight: 1 })
    let releaseFirst: (() => void) | undefined
    listServiceEndpointsForOrg.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve([RAW_ROW])
        })
    )

    const first = host.listServiceEndpointsForScheduling({ organizationId: ORG_ID })
    await expect(
      host.listServiceEndpointsForScheduling({ organizationId: ORG_ID })
    ).rejects.toBeInstanceOf(MonitoringRateLimitedError)

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG_ID,
        extensionName: MANIFEST.name,
        method: 'listServiceEndpointsForScheduling',
        outcome: 'rate-limited',
      }),
      expect.any(String)
    )

    releaseFirst?.()
    await first
  })

  it('AC6: records an audit log entry with outcome "error" when the service layer throws', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }
    const host = buildMonitoringHost(MANIFEST, logger)
    const dbError = new Error('malformed UUID')
    listServiceEndpointsForOrg.mockRejectedValue(dbError)

    await expect(
      host.listServiceEndpointsForScheduling({ organizationId: ORG_ID })
    ).rejects.toThrow(dbError)

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG_ID,
        extensionName: MANIFEST.name,
        method: 'listServiceEndpointsForScheduling',
        outcome: 'error',
      }),
      expect.any(String)
    )
  })

  it('malformed (non-UUID) organizationId: the underlying DB error propagates unmodified — no pre-validation added, consistent with cleanupProjectMonitoring precedent', async () => {
    const dbError = new Error('invalid input syntax for type uuid: "not-a-uuid"')
    listServiceEndpointsForOrg.mockRejectedValue(dbError)
    const host = buildMonitoringHost(MANIFEST)

    await expect(
      host.listServiceEndpointsForScheduling({ organizationId: 'not-a-uuid' })
    ).rejects.toBe(dbError)
  })

  it("AC2 negative example: listServiceEndpointsForOrg's source never references serializeServiceEndpoint or redactUrlForDisplay", () => {
    const source = readFileSync(join(process.cwd(), 'src/modules/monitoring/service.ts'), 'utf-8')
    const fnStart = source.indexOf('export async function listServiceEndpointsForOrg')
    expect(fnStart).toBeGreaterThan(-1)
    const nextExportStart = source.indexOf('\nexport ', fnStart + 1)
    const fnSource = source.slice(fnStart, nextExportStart === -1 ? undefined : nextExportStart)

    expect(fnSource.includes('serializeServiceEndpoint')).toBe(false)
    expect(fnSource.includes('redactUrlForDisplay')).toBe(false)
  })
})
