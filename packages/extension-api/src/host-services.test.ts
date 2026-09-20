import { describe, expect, it } from 'vitest'
import type { HostServices } from './host-services.js'
import type { PvMonitoringHost } from './hooks/monitoring.js'
import type { NotificationOriginatorHost } from './hooks/notification-originator.js'
import type { ExtensionRequestStateHostService } from './hooks/extension-request-state.js'
import type { CredentialSharingHost } from './hooks/credential-sharing.js'

const TEST_DATE = '2026-01-01'

const monitoringFixture: PvMonitoringHost = {
  deleteServiceEndpoint: async () => null,
  updateServiceEndpointPauseState: async () => null,
  getHealthDashboardData: async () => ({
    projects: [],
    summary: { healthy: 0, degraded: 0, down: 0 },
  }),
  enableStatusPage: async () => ({ id: '1', token: 'tok', createdAt: TEST_DATE }),
  regenerateStatusPageToken: async () => ({ id: '1', token: 'tok', updatedAt: TEST_DATE }),
  disableStatusPage: async () => null,
  applyHealthCheckResult: async () => ({
    alertFired: null,
    episodeKey: null,
    updatedRow: {
      id: '1',
      orgId: 'org1',
      projectId: 'p1',
      name: 'svc',
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
      createdAt: TEST_DATE,
      updatedAt: TEST_DATE,
    },
  }),
  cleanupProjectMonitoring: async () => ({ resolvedAlertCount: 0 }),
  createServiceEndpoint: async () => ({
    id: '1',
    orgId: 'org1',
    projectId: 'p1',
    name: 'svc',
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
    createdAt: TEST_DATE,
    updatedAt: TEST_DATE,
  }),
  listServiceEndpointsForScheduling: async () => [],
}

const notificationOriginatorFixture: NotificationOriginatorHost = {
  enqueueNotification: async () => ({ notificationQueueId: 'nq1' }),
  enqueueNotificationForOrg: async () => ({ notificationQueueId: 'nq2' }),
}

const extensionRequestStateFixture: ExtensionRequestStateHostService = {
  consume: async () => undefined,
}

const credentialSharingFixture: CredentialSharingHost = {
  createExternalShare: async () => ({ status: 'credential_not_found' }),
  findShareByToken: async () => ({ status: 'not_found' }),
  revealShare: async () => ({ status: 'not_found' }),
  revokeShare: async () => ({ status: 'not_found' }),
  supersedeSharesForRotation: async () => ({ supersededShares: [] }),
}

describe('HostServices — Story 20.12 AC widening to include credentialSharing', () => {
  it('exposes exactly auditEventSource/orgAuthorization/projectAuthorization/ephemeralState/monitoring/notificationOriginator/extensionRequestState/credentialSharing', () => {
    const fixture: HostServices = {
      auditEventSource: { writeAuditEvent: async () => ({ id: '1', createdAt: TEST_DATE }) },
      orgAuthorization: { checkMembership: async () => ({ outcome: 'authorized' }) },
      projectAuthorization: { checkProjectMembership: async () => ({ outcome: 'authorized' }) },
      ephemeralState: {
        set: async () => undefined,
        get: async () => undefined,
        delete: async () => undefined,
        compareAndSwap: async () => true,
        compareAndDelete: async () => true,
      },
      monitoring: monitoringFixture,
      notificationOriginator: notificationOriginatorFixture,
      extensionRequestState: extensionRequestStateFixture,
      credentialSharing: credentialSharingFixture,
    }
    expect(new Set(Object.keys(fixture))).toEqual(
      new Set([
        'auditEventSource',
        'orgAuthorization',
        'projectAuthorization',
        'ephemeralState',
        'monitoring',
        'notificationOriginator',
        'extensionRequestState',
        'credentialSharing',
      ])
    )
  })

  it('an existing hooksFactory destructuring only { auditEventSource } still type-checks against the widened HostServices (additive-only)', () => {
    function legacyHooksFactory(host: {
      auditEventSource: HostServices['auditEventSource']
    }): void {
      expect(typeof host.auditEventSource.writeAuditEvent).toBe('function')
    }
    const host: HostServices = {
      auditEventSource: { writeAuditEvent: async () => ({ id: '1', createdAt: TEST_DATE }) },
      orgAuthorization: { checkMembership: async () => ({ outcome: 'authorized' }) },
      projectAuthorization: { checkProjectMembership: async () => ({ outcome: 'authorized' }) },
      ephemeralState: {
        set: async () => undefined,
        get: async () => undefined,
        delete: async () => undefined,
        compareAndSwap: async () => true,
        compareAndDelete: async () => true,
      },
      monitoring: monitoringFixture,
      notificationOriginator: notificationOriginatorFixture,
      extensionRequestState: extensionRequestStateFixture,
      credentialSharing: credentialSharingFixture,
    }
    legacyHooksFactory(host)
  })

  it('a zero-parameter hooksFactory extension remains structurally valid against monitoring (AC1 edge case)', () => {
    function zeroParamHooksFactory(): { name: string } {
      return { name: 'legacy' }
    }
    // A hooksFactory taking no HostServices parameter at all is still assignable to
    // (host: HostServices) => ExtensionHooks by TypeScript's parameter-count contravariance.
    const factory: (host: HostServices) => { name: string } = zeroParamHooksFactory
    expect(factory).toBe(zeroParamHooksFactory)
  })
})
