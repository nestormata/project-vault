import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionManifest } from '@project-vault/extension-api'
import { MonitoringResourceNotFoundError } from '@project-vault/extension-api'

/**
 * Story 41.1 Task 4 — "unit tests ... ServiceEndpointLimitReachedError/UrlNotMonitorableError
 * propagation (AC5, mocked service layer)". Real-Postgres exercise of `createServiceEndpoint`'s
 * happy/AC4 paths lives in `monitoring-host.integration.test.ts`; this file isolates the
 * closure's own control flow (AC4 `findProjectInOrg` gate, AC5 unmodified error propagation, AC6
 * thin-pass-through argument wiring) from a live database, mirroring `project-authorization.
 * test.ts`'s own `withOrg`-mocking precedent.
 */

const { withOrg } = vi.hoisted(() => ({ withOrg: vi.fn() }))
vi.mock('@project-vault/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@project-vault/db')>()
  return { ...actual, withOrg }
})

const { createServiceEndpointService, serializeServiceEndpoint } = vi.hoisted(() => ({
  createServiceEndpointService: vi.fn(),
  serializeServiceEndpoint: vi.fn((row: unknown) => ({ serialized: true, row })),
}))
vi.mock('../modules/monitoring/service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../modules/monitoring/service.js')>()
  return {
    ...actual,
    createServiceEndpoint: createServiceEndpointService,
    serializeServiceEndpoint,
  }
})

const { findProjectInOrg } = vi.hoisted(() => ({ findProjectInOrg: vi.fn() }))
vi.mock('../modules/credentials/service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../modules/credentials/service.js')>()
  return { ...actual, findProjectInOrg }
})

const { ServiceEndpointLimitReachedError, UrlNotMonitorableError } =
  await import('../modules/monitoring/service.js')
const { buildMonitoringHost } = await import('./monitoring-host.js')
const { runWithRequestContext } = await import('./request-context.js')

// Test-fixture values, not secrets.
/* eslint-disable no-secrets/no-secrets */
const AMBIENT_ORG_ID = '11111111-1111-1111-1111-111111111111'
const PROJECT_ID = '22222222-2222-2222-2222-222222222222'
const USER_ID = '33333333-3333-3333-3333-333333333333'
/* eslint-enable no-secrets/no-secrets */

const MANIFEST: ExtensionManifest = {
  name: 'com.acme.create-service-endpoint-fixture',
  apiVersion: '3.17.0',
  capabilities: [],
}

const FAKE_TX = { __fakeTx: true }

function bindAndCreate(host: ReturnType<typeof buildMonitoringHost>, overrides = {}) {
  return runWithRequestContext({ orgId: AMBIENT_ORG_ID, userId: USER_ID }, () =>
    host.createServiceEndpoint({
      projectId: PROJECT_ID,
      userId: USER_ID,
      name: 'My Check',
      url: 'https://example.com',
      ...overrides,
    })
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  withOrg.mockImplementation(async (_orgId: string, fn: (tx: unknown) => unknown) => fn(FAKE_TX))
  findProjectInOrg.mockResolvedValue(true)
  createServiceEndpointService.mockResolvedValue({ id: 'row-1' })
})

describe('buildMonitoringHost.createServiceEndpoint (Story 41.1 AC4, AC5, AC6)', () => {
  it('AC6 happy path: resolves the project within org, calls the real service function with the thin-pass-through args, and serializes the result', async () => {
    const host = buildMonitoringHost(MANIFEST)
    const result = await bindAndCreate(host, { checkFrequencyMinutes: 5, downThresholdFailures: 3 })

    expect(findProjectInOrg).toHaveBeenCalledWith(FAKE_TX, PROJECT_ID)
    expect(createServiceEndpointService).toHaveBeenCalledWith(FAKE_TX, {
      orgId: AMBIENT_ORG_ID,
      projectId: PROJECT_ID,
      userId: USER_ID,
      body: {
        name: 'My Check',
        url: 'https://example.com',
        checkFrequencyMinutes: 5,
        downThresholdFailures: 3,
      },
    })
    expect(serializeServiceEndpoint).toHaveBeenCalledWith({ id: 'row-1' })
    expect(result).toEqual({ serialized: true, row: { id: 'row-1' } })
  })

  it('AC4 rejects with MonitoringResourceNotFoundError when findProjectInOrg misses, and never calls the service function', async () => {
    findProjectInOrg.mockResolvedValue(false)
    const host = buildMonitoringHost(MANIFEST)

    await expect(bindAndCreate(host)).rejects.toBeInstanceOf(MonitoringResourceNotFoundError)
    expect(createServiceEndpointService).not.toHaveBeenCalled()
  })

  it('AC5 lets ServiceEndpointLimitReachedError propagate unmodified', async () => {
    createServiceEndpointService.mockRejectedValue(new ServiceEndpointLimitReachedError(25))
    const host = buildMonitoringHost(MANIFEST)

    await expect(bindAndCreate(host)).rejects.toBeInstanceOf(ServiceEndpointLimitReachedError)
  })

  it('AC5 lets UrlNotMonitorableError propagate unmodified', async () => {
    createServiceEndpointService.mockRejectedValue(new UrlNotMonitorableError())
    const host = buildMonitoringHost(MANIFEST)

    await expect(bindAndCreate(host)).rejects.toBeInstanceOf(UrlNotMonitorableError)
  })
})
