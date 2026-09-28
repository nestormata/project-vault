import type { ExtensionHooks, ExtensionManifest, HostServices } from '@project-vault/extension-api'
import { __setExtensionStateForTests } from '../extensions/loader.js'

/**
 * Shared fakes for the scheduled-task worker suites (Story 56.1's
 * `extension-scheduled-tasks.test.ts` and Story 56.2's `extension-scheduled-tasks-watchdog.test.ts`).
 * Named `*test-helpers*` so jscpd's repo-wide duplication gate excludes it.
 */

/** Minimal, rejecting-by-default HostServices — mirrors register-extension.ts's own
 * DEFAULT_HOST_SERVICES fallback shape. Only `monitoring` is ever overridden for the regression
 * guard test; every other field must never be reachable from this suite's own test handlers. */
export function fakeHostServices(overrides: Partial<HostServices> = {}): HostServices {
  const unavailable = (name: string) => () =>
    Promise.reject(new Error(`${name} is unavailable in this test`))
  return {
    auditEventSource: { writeAuditEvent: unavailable('auditEventSource.writeAuditEvent') },
    orgAuthorization: { checkMembership: unavailable('orgAuthorization.checkMembership') },
    projectAuthorization: {
      checkProjectMembership: unavailable('projectAuthorization.checkProjectMembership'),
    },
    ephemeralState: {
      set: unavailable('ephemeralState.set'),
      get: unavailable('ephemeralState.get'),
      delete: unavailable('ephemeralState.delete'),
      compareAndSwap: unavailable('ephemeralState.compareAndSwap'),
      compareAndDelete: unavailable('ephemeralState.compareAndDelete'),
    },
    monitoring: {
      createServiceEndpoint: unavailable('monitoring.createServiceEndpoint'),
      deleteServiceEndpoint: unavailable('monitoring.deleteServiceEndpoint'),
      updateServiceEndpointPauseState: unavailable('monitoring.updateServiceEndpointPauseState'),
      getHealthDashboardData: unavailable('monitoring.getHealthDashboardData'),
      enableStatusPage: unavailable('monitoring.enableStatusPage'),
      regenerateStatusPageToken: unavailable('monitoring.regenerateStatusPageToken'),
      disableStatusPage: unavailable('monitoring.disableStatusPage'),
      applyHealthCheckResult: unavailable('monitoring.applyHealthCheckResult'),
      cleanupProjectMonitoring: unavailable('monitoring.cleanupProjectMonitoring'),
      listServiceEndpointsForScheduling: unavailable(
        'monitoring.listServiceEndpointsForScheduling'
      ),
    },
    notificationOriginator: {
      enqueueNotification: unavailable('notificationOriginator.enqueueNotification'),
      enqueueNotificationForOrg: unavailable('notificationOriginator.enqueueNotificationForOrg'),
    },
    extensionRequestState: {
      consume: unavailable('extensionRequestState.consume'),
    },
    credentialSharing: {
      createExternalShare: unavailable('credentialSharing.createExternalShare'),
      findShareByToken: unavailable('credentialSharing.findShareByToken'),
      revealShare: unavailable('credentialSharing.revealShare'),
      revokeShare: unavailable('credentialSharing.revokeShare'),
      supersedeSharesForRotation: unavailable('credentialSharing.supersedeSharesForRotation'),
      listSharesForCredential: unavailable('credentialSharing.listSharesForCredential'),
      listSharesForOrganization: unavailable('credentialSharing.listSharesForOrganization'),
    },
    ...overrides,
  }
}

export function setExtension(
  manifest: ExtensionManifest,
  hooks: ExtensionHooks,
  hostServices: HostServices = fakeHostServices()
): void {
  __setExtensionStateForTests({
    status: 'loaded',
    manifest,
    loadedAt: new Date().toISOString(),
    hooks,
    hostServices,
  })
}
