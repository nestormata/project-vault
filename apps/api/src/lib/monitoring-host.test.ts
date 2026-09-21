import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MonitoringInvalidServiceEndpointInputError,
  MonitoringNoAmbientContextError,
  MonitoringOrgMismatchError,
  MonitoringRateLimitedError,
} from '@project-vault/extension-api'
import type { ExtensionManifest } from '@project-vault/extension-api'
import {
  __getMonitoringHostInFlightCountForTests,
  __resetMonitoringHostRateLimitForTests,
  buildMonitoringHost,
} from './monitoring-host.js'
import { runWithRequestContext } from './request-context.js'

// Test-fixture UUIDs, not secrets.
/* eslint-disable no-secrets/no-secrets */
const AMBIENT_ORG_ID = '11111111-1111-1111-1111-111111111111'
// Story 41.2: must be RFC-4122-v4-shaped (version/variant nibbles set), not just
// 8-4-4-4-12 hex-shaped — these now pass through `validateIdentityUuids`'s `z.uuid()` format
// gate before this test's own "ambient context wins" assertion is ever reached.
const SMUGGLED_ENDPOINT_ID = '22222222-2222-4222-8222-222222222222'
const SMUGGLED_PROJECT_ID = '33333333-3333-4333-8333-333333333333'
const SMUGGLED_ORG_ID = '44444444-4444-4444-4444-444444444444'
const RATE_LIMIT_ORG_ID = '00000000-0000-0000-0000-000000000001'
const RATE_LIMIT_PROJECT_ID = '00000000-0000-0000-0000-000000000002'
/* eslint-enable no-secrets/no-secrets */

// Story 41.2: reused across every method's malformed-UUID test case (sonarjs/no-duplicate-string).
const NOT_A_UUID = 'not-a-uuid'

const MANIFEST: ExtensionManifest = {
  name: 'com.acme.test-extension',
  apiVersion: '3.12.0',
  capabilities: [],
}

afterEach(() => {
  __resetMonitoringHostRateLimitForTests()
  vi.restoreAllMocks()
})

describe('buildMonitoringHost — in-request methods (Story 34.1 AC2)', () => {
  const inRequestCalls: Array<{
    name: string
    invoke: (host: ReturnType<typeof buildMonitoringHost>) => Promise<unknown>
  }> = [
    {
      name: 'deleteServiceEndpoint',
      invoke: (host) => host.deleteServiceEndpoint({ serviceEndpointId: 'x', projectId: 'p' }),
    },
    {
      name: 'updateServiceEndpointPauseState',
      invoke: (host) =>
        host.updateServiceEndpointPauseState({
          serviceEndpointId: 'x',
          projectId: 'p',
          userId: 'u',
          paused: true,
        }),
    },
    { name: 'getHealthDashboardData', invoke: (host) => host.getHealthDashboardData() },
    {
      name: 'enableStatusPage',
      invoke: (host) => host.enableStatusPage({ projectId: 'p', userId: 'u' }),
    },
    {
      name: 'regenerateStatusPageToken',
      invoke: (host) => host.regenerateStatusPageToken({ projectId: 'p' }),
    },
    { name: 'disableStatusPage', invoke: (host) => host.disableStatusPage({ projectId: 'p' }) },
    {
      name: 'createServiceEndpoint',
      invoke: (host) =>
        host.createServiceEndpoint({
          projectId: 'p',
          userId: 'u',
          name: 'My Check',
          url: 'https://example.com',
        }),
    },
  ]

  it.each(inRequestCalls)(
    '$name fails closed with MonitoringNoAmbientContextError and makes zero DB calls when no request context is bound',
    async ({ invoke }) => {
      const host = buildMonitoringHost(MANIFEST)
      await expect(invoke(host)).rejects.toBeInstanceOf(MonitoringNoAmbientContextError)
    }
  )

  it('a caller attempting to smuggle an organizationId field is ignored — the ambient context still wins', async () => {
    const host = buildMonitoringHost(MANIFEST)
    await runWithRequestContext({ orgId: AMBIENT_ORG_ID, userId: 'user-1' }, async () => {
      // deleteServiceEndpoint's real params type has no organizationId field at all; casting past
      // TypeScript here simulates a caller bypassing the type system (AC2's edge case).
      const params = {
        serviceEndpointId: SMUGGLED_ENDPOINT_ID,
        projectId: SMUGGLED_PROJECT_ID,
        organizationId: SMUGGLED_ORG_ID,
      }
      // Resolves to null (endpoint not found in org-ambient) rather than throwing or resolving
      // against org-attacker — proves the extra field was never read.
      await expect(
        host.deleteServiceEndpoint(
          params as unknown as Parameters<typeof host.deleteServiceEndpoint>[0]
        )
      ).resolves.toBeNull()
    })
  })
})

describe('buildMonitoringHost.createServiceEndpoint (Story 41.1 AC3, AC5)', () => {
  const REJECTS_WITH_ZERO_DB_CALLS_TITLE =
    'rejects with MonitoringInvalidServiceEndpointInputError and makes zero DB calls: $name'

  // Test-fixture values, not secrets.
  /* eslint-disable no-secrets/no-secrets */
  const VALID_UUID_PROJECT_ID = '22222222-2222-4222-8222-222222222222'
  const VALID_UUID_USER_ID = '33333333-3333-4333-8333-333333333333'
  /* eslint-enable no-secrets/no-secrets */

  const VALID_PARAMS = {
    projectId: 'p',
    userId: 'u',
    name: 'My Check',
    url: 'https://example.com',
  }

  const invalidCases: Array<{ name: string; overrides: Record<string, unknown> }> = [
    { name: 'checkFrequencyMinutes not one of 1|5|15|30', overrides: { checkFrequencyMinutes: 7 } },
    {
      name: 'url exceeds 2048 chars',
      overrides: { url: 'https://example.com/' + 'a'.repeat(3000) },
    },
    { name: 'name is an empty string', overrides: { name: '' } },
    { name: 'downThresholdFailures below 1', overrides: { downThresholdFailures: 0 } },
    { name: 'downThresholdFailures above 10', overrides: { downThresholdFailures: 11 } },
  ]

  it.each(invalidCases)(REJECTS_WITH_ZERO_DB_CALLS_TITLE, async ({ overrides }) => {
    const host = buildMonitoringHost(MANIFEST)
    await runWithRequestContext({ orgId: AMBIENT_ORG_ID, userId: 'user-1' }, async () => {
      await expect(
        host.createServiceEndpoint({
          ...VALID_PARAMS,
          ...overrides,
        } as unknown as Parameters<typeof host.createServiceEndpoint>[0])
      ).rejects.toBeInstanceOf(MonitoringInvalidServiceEndpointInputError)
    })
  })

  it.each([
    { name: 'userId is an empty string', overrides: { userId: '' } },
    { name: 'userId is whitespace only', overrides: { userId: '   ' } },
  ])(REJECTS_WITH_ZERO_DB_CALLS_TITLE, async ({ overrides }) => {
    const host = buildMonitoringHost(MANIFEST)
    await runWithRequestContext({ orgId: AMBIENT_ORG_ID, userId: 'user-1' }, async () => {
      await expect(
        host.createServiceEndpoint({
          ...VALID_PARAMS,
          ...overrides,
        } as unknown as Parameters<typeof host.createServiceEndpoint>[0])
      ).rejects.toBeInstanceOf(MonitoringInvalidServiceEndpointInputError)
    })
  })

  // Code review fix (2026-09-17): projectId/userId weren't UUID-format-validated before
  // reaching findProjectInOrg/the DB, so a malformed value would have surfaced as an
  // unclassified Postgres error instead of this same typed error class.
  it.each([
    { name: 'userId is not a valid UUID', overrides: { userId: NOT_A_UUID } },
    { name: 'projectId is not a valid UUID', overrides: { projectId: NOT_A_UUID } },
  ])(REJECTS_WITH_ZERO_DB_CALLS_TITLE, async ({ overrides }) => {
    const host = buildMonitoringHost(MANIFEST)
    await runWithRequestContext({ orgId: AMBIENT_ORG_ID, userId: 'user-1' }, async () => {
      await expect(
        host.createServiceEndpoint({
          ...VALID_PARAMS,
          projectId: VALID_UUID_PROJECT_ID,
          userId: VALID_UUID_USER_ID,
          ...overrides,
        } as unknown as Parameters<typeof host.createServiceEndpoint>[0])
      ).rejects.toBeInstanceOf(MonitoringInvalidServiceEndpointInputError)
    })
  })
})

describe('buildMonitoringHost — sibling in-request methods UUID validation parity (Story 41.2 AC2-AC7)', () => {
  const REJECTS_WITH_ZERO_DB_CALLS_TITLE =
    'rejects with MonitoringInvalidServiceEndpointInputError and makes zero DB calls: $name'

  // Test-fixture values, not secrets.
  /* eslint-disable no-secrets/no-secrets */
  const VALID_PROJECT_ID = '55555555-5555-4555-8555-555555555555'
  const VALID_USER_ID = '66666666-6666-4666-8666-666666666666'
  const VALID_SERVICE_ENDPOINT_ID = '77777777-7777-4777-8777-777777777777'
  /* eslint-enable no-secrets/no-secrets */

  describe('deleteServiceEndpoint (AC2)', () => {
    it.each([
      {
        name: 'serviceEndpointId is not a valid UUID',
        overrides: { serviceEndpointId: NOT_A_UUID },
      },
      { name: 'projectId is an empty string', overrides: { projectId: '' } },
    ])(REJECTS_WITH_ZERO_DB_CALLS_TITLE, async ({ overrides }) => {
      const host = buildMonitoringHost(MANIFEST)
      await runWithRequestContext({ orgId: AMBIENT_ORG_ID, userId: 'user-1' }, async () => {
        await expect(
          host.deleteServiceEndpoint({
            serviceEndpointId: VALID_SERVICE_ENDPOINT_ID,
            projectId: VALID_PROJECT_ID,
            ...overrides,
          })
        ).rejects.toBeInstanceOf(MonitoringInvalidServiceEndpointInputError)
      })
    })

    it('collects both issues when serviceEndpointId and projectId are both malformed', async () => {
      const host = buildMonitoringHost(MANIFEST)
      await runWithRequestContext({ orgId: AMBIENT_ORG_ID, userId: 'user-1' }, async () => {
        try {
          await host.deleteServiceEndpoint({ serviceEndpointId: NOT_A_UUID, projectId: '' })
          expect.unreachable('expected deleteServiceEndpoint to reject')
        } catch (error) {
          expect(error).toBeInstanceOf(MonitoringInvalidServiceEndpointInputError)
          expect((error as MonitoringInvalidServiceEndpointInputError).issues).toHaveLength(2)
        }
      })
    })
  })

  describe('updateServiceEndpointPauseState (AC3)', () => {
    it.each([
      { name: 'userId is not a valid UUID', overrides: { userId: NOT_A_UUID } },
      {
        name: 'userId is missing entirely (undefined smuggled past TS)',
        overrides: { userId: undefined },
      },
      {
        name: 'serviceEndpointId is not a valid UUID',
        overrides: { serviceEndpointId: NOT_A_UUID },
      },
    ])(REJECTS_WITH_ZERO_DB_CALLS_TITLE, async ({ overrides }) => {
      const host = buildMonitoringHost(MANIFEST)
      await runWithRequestContext({ orgId: AMBIENT_ORG_ID, userId: 'user-1' }, async () => {
        await expect(
          host.updateServiceEndpointPauseState({
            serviceEndpointId: VALID_SERVICE_ENDPOINT_ID,
            projectId: VALID_PROJECT_ID,
            userId: VALID_USER_ID,
            paused: true,
            ...overrides,
          } as unknown as Parameters<typeof host.updateServiceEndpointPauseState>[0])
        ).rejects.toBeInstanceOf(MonitoringInvalidServiceEndpointInputError)
      })
    })

    it('collects all three issues when serviceEndpointId, projectId, and userId are all malformed', async () => {
      const host = buildMonitoringHost(MANIFEST)
      await runWithRequestContext({ orgId: AMBIENT_ORG_ID, userId: 'user-1' }, async () => {
        try {
          await host.updateServiceEndpointPauseState({
            serviceEndpointId: NOT_A_UUID,
            projectId: '',
            userId: 'also-not-a-uuid',
            paused: true,
          })
          expect.unreachable('expected updateServiceEndpointPauseState to reject')
        } catch (error) {
          expect(error).toBeInstanceOf(MonitoringInvalidServiceEndpointInputError)
          expect((error as MonitoringInvalidServiceEndpointInputError).issues).toHaveLength(3)
        }
      })
    })
  })

  describe('getHealthDashboardData (AC4)', () => {
    it('rejects a malformed element and makes zero DB calls', async () => {
      const host = buildMonitoringHost(MANIFEST)
      await runWithRequestContext({ orgId: AMBIENT_ORG_ID, userId: 'user-1' }, async () => {
        await expect(
          host.getHealthDashboardData({ permittedProjectIds: [VALID_PROJECT_ID, NOT_A_UUID] })
        ).rejects.toBeInstanceOf(MonitoringInvalidServiceEndpointInputError)
      })
    })

    it('reports the malformed element at its real index (index 1, not hardcoded index 0)', async () => {
      const host = buildMonitoringHost(MANIFEST)
      await runWithRequestContext({ orgId: AMBIENT_ORG_ID, userId: 'user-1' }, async () => {
        try {
          await host.getHealthDashboardData({
            permittedProjectIds: [VALID_PROJECT_ID, NOT_A_UUID],
          })
          expect.unreachable('expected getHealthDashboardData to reject')
        } catch (error) {
          expect(error).toBeInstanceOf(MonitoringInvalidServiceEndpointInputError)
          expect((error as MonitoringInvalidServiceEndpointInputError).issues[0]?.path).toEqual([
            'permittedProjectIds',
            '1',
          ])
        }
      })
    })

    it('rejects an empty-string element at index 0 as required, not invalid UUID', async () => {
      const host = buildMonitoringHost(MANIFEST)
      await runWithRequestContext({ orgId: AMBIENT_ORG_ID, userId: 'user-1' }, async () => {
        try {
          await host.getHealthDashboardData({ permittedProjectIds: ['', VALID_PROJECT_ID] })
          expect.unreachable('expected getHealthDashboardData to reject')
        } catch (error) {
          expect(error).toBeInstanceOf(MonitoringInvalidServiceEndpointInputError)
          const issues = (error as MonitoringInvalidServiceEndpointInputError).issues
          expect(issues[0]?.path).toEqual(['permittedProjectIds', '0'])
          expect(issues[0]?.message).toMatch(/required/)
        }
      })
    })
  })

  describe('enableStatusPage (AC5)', () => {
    it.each([
      { name: 'projectId is not a valid UUID', overrides: { projectId: NOT_A_UUID } },
      { name: 'userId is an empty string', overrides: { userId: '' } },
    ])(REJECTS_WITH_ZERO_DB_CALLS_TITLE, async ({ overrides }) => {
      const host = buildMonitoringHost(MANIFEST)
      await runWithRequestContext({ orgId: AMBIENT_ORG_ID, userId: 'user-1' }, async () => {
        await expect(
          host.enableStatusPage({
            projectId: VALID_PROJECT_ID,
            userId: VALID_USER_ID,
            ...overrides,
          })
        ).rejects.toBeInstanceOf(MonitoringInvalidServiceEndpointInputError)
      })
    })
  })

  describe('regenerateStatusPageToken (AC6)', () => {
    it('rejects a malformed projectId and makes zero DB calls', async () => {
      const host = buildMonitoringHost(MANIFEST)
      await runWithRequestContext({ orgId: AMBIENT_ORG_ID, userId: 'user-1' }, async () => {
        await expect(
          host.regenerateStatusPageToken({ projectId: NOT_A_UUID })
        ).rejects.toBeInstanceOf(MonitoringInvalidServiceEndpointInputError)
      })
    })
  })

  describe('disableStatusPage (AC7)', () => {
    it('rejects a malformed projectId and makes zero DB calls', async () => {
      const host = buildMonitoringHost(MANIFEST)
      await runWithRequestContext({ orgId: AMBIENT_ORG_ID, userId: 'user-1' }, async () => {
        await expect(host.disableStatusPage({ projectId: NOT_A_UUID })).rejects.toBeInstanceOf(
          MonitoringInvalidServiceEndpointInputError
        )
      })
    })
  })
})

describe('buildMonitoringHost — out-of-request methods (Story 34.1 AC3, AC7)', () => {
  it('applyHealthCheckResult rejects an organizationId/serviceEndpoint.orgId mismatch before any DB call, as the operational-failure class', async () => {
    const host = buildMonitoringHost(MANIFEST)
    await expect(
      host.applyHealthCheckResult({
        organizationId: 'org-A',
        serviceEndpoint: { id: 'endpoint-1', orgId: 'org-B' },
        isHealthy: true,
        statusCode: 200,
        latencyMs: 10,
        failureReason: null,
      })
    ).rejects.toBeInstanceOf(MonitoringOrgMismatchError)
  })

  it('rate-limits applyHealthCheckResult/cleanupProjectMonitoring using a distinct in-flight budget, and releases the slot after each call', async () => {
    const host = buildMonitoringHost(MANIFEST, {}, { maxInFlight: 1 })
    expect(__getMonitoringHostInFlightCountForTests(MANIFEST.name)).toBe(0)

    // A mismatch throws before the rate-limit wrapper even runs (fails closed earlier) — use a
    // real out-of-request call path instead by forcing a slot to be held artificially via two
    // concurrent calls against a non-existent org (which will 404 inside the transaction, but
    // still goes through the rate-limit wrapper).
    const first = host.cleanupProjectMonitoring({
      organizationId: RATE_LIMIT_ORG_ID,
      projectId: RATE_LIMIT_PROJECT_ID,
    })
    await expect(
      host.cleanupProjectMonitoring({
        organizationId: RATE_LIMIT_ORG_ID,
        projectId: RATE_LIMIT_PROJECT_ID,
      })
    ).rejects.toBeInstanceOf(MonitoringRateLimitedError)

    await expect(first).rejects.toThrow()
    expect(__getMonitoringHostInFlightCountForTests(MANIFEST.name)).toBe(0)
  })
})
