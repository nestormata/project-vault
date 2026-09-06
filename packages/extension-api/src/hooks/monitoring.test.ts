import { describe, expect, it } from 'vitest'
import {
  MonitoringNoAmbientContextError,
  MonitoringOrgMismatchError,
  MonitoringRateLimitedError,
  MonitoringResourceNotFoundError,
  type MonitoringServiceEndpointRecord,
  type PvMonitoringHost,
} from './monitoring.js'

const FIXTURE_SERVICE_ENDPOINT: MonitoringServiceEndpointRecord = {
  id: 'se_1',
  orgId: 'org_1',
  projectId: 'p_1',
  name: 'Fixture Endpoint',
  url: 'https://example.com',
  checkFrequencyMinutes: 5,
  downThresholdFailures: 2,
  status: 'healthy',
  consecutiveFailures: 0,
  lastCheckedAt: null,
  healthCheckPaused: false,
  healthCheckPausedAt: null,
  healthCheckPausedBy: null,
  createdBy: null,
  createdAt: '2026-09-06T00:00:00.000Z',
  updatedAt: '2026-09-06T00:00:00.000Z',
}

describe('monitoring hook error classes (Story 34.1 AC2/AC3/AC6/AC7)', () => {
  it('MonitoringNoAmbientContextError carries the method name and a stable code/name', () => {
    const error = new MonitoringNoAmbientContextError('deleteServiceEndpoint')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('MonitoringNoAmbientContextError')
    expect(error.code).toBe('monitoring_no_ambient_context')
    expect(error.message).toContain('deleteServiceEndpoint')
  })

  it('MonitoringRateLimitedError carries the method name and a stable code/name', () => {
    const error = new MonitoringRateLimitedError('applyHealthCheckResult')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('MonitoringRateLimitedError')
    expect(error.code).toBe('monitoring_rate_limited')
    expect(error.message).toContain('applyHealthCheckResult')
  })

  it('MonitoringOrgMismatchError carries the method name and a stable code/name', () => {
    const error = new MonitoringOrgMismatchError('applyHealthCheckResult')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('MonitoringOrgMismatchError')
    expect(error.code).toBe('monitoring_org_mismatch')
    expect(error.message).toContain('applyHealthCheckResult')
  })

  it('MonitoringResourceNotFoundError carries the method name, message, and a stable code/name', () => {
    const error = new MonitoringResourceNotFoundError(
      'cleanupProjectMonitoring',
      'project not found in this org'
    )
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('MonitoringResourceNotFoundError')
    expect(error.code).toBe('monitoring_resource_not_found')
    expect(error.message).toContain('cleanupProjectMonitoring')
    expect(error.message).toContain('project not found in this org')
  })
})

describe('PvMonitoringHost — the inverted hook shape (Story 34.1 AC1/AC2/AC3)', () => {
  it('typechecks a full implementation covering all eight methods', async () => {
    const host: PvMonitoringHost = {
      deleteServiceEndpoint: async () => null,
      updateServiceEndpointPauseState: async () => null,
      getHealthDashboardData: async () => ({
        projects: [],
        summary: { healthy: 0, degraded: 0, down: 0 },
      }),
      enableStatusPage: async () => ({ id: 'sp_1', token: 'tok', createdAt: '' }),
      regenerateStatusPageToken: async () => ({ id: 'sp_1', token: 'tok2', updatedAt: '' }),
      disableStatusPage: async () => null,
      applyHealthCheckResult: async () => ({
        alertFired: null,
        episodeKey: null,
        updatedRow: FIXTURE_SERVICE_ENDPOINT,
      }),
      cleanupProjectMonitoring: async () => ({ resolvedAlertCount: 0 }),
    }

    expect(await host.deleteServiceEndpoint({ serviceEndpointId: 'se_1', projectId: 'p_1' })).toBe(
      null
    )
    expect(await host.getHealthDashboardData()).toEqual({
      projects: [],
      summary: { healthy: 0, degraded: 0, down: 0 },
    })
    expect(
      await host.cleanupProjectMonitoring({ organizationId: 'org_1', projectId: 'p_1' })
    ).toEqual({ resolvedAlertCount: 0 })

    const applyResult = await host.applyHealthCheckResult({
      organizationId: 'org_1',
      serviceEndpoint: { id: 'se_1', orgId: 'org_1' },
      isHealthy: true,
      statusCode: 200,
      latencyMs: 42,
      failureReason: null,
    })
    expect(applyResult.updatedRow).toEqual(FIXTURE_SERVICE_ENDPOINT)

    const enableResult = await host.enableStatusPage({ projectId: 'p_1', userId: 'u_1' })
    expect(enableResult.id).toBe('sp_1')

    const regenResult = await host.regenerateStatusPageToken({ projectId: 'p_1' })
    expect(regenResult.token).toBe('tok2')

    expect(
      await host.updateServiceEndpointPauseState({
        serviceEndpointId: 'se_1',
        projectId: 'p_1',
        userId: 'u_1',
        paused: true,
      })
    ).toBe(null)

    expect(await host.disableStatusPage({ projectId: 'p_1' })).toBe(null)
  })
})
