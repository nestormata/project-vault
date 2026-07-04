import { describe, expect, it } from 'vitest'
import {
  paymentRecords,
  certRecords,
  domainRecords,
  serviceEndpoints,
  endpointHealthChecks,
  monitoringAlerts,
} from './index.js'
import { EXCLUDED_TABLES } from '../check-rls-coverage.js'

describe('payment_records schema', () => {
  it('exposes org-scoped payment_records columns', () => {
    expect(paymentRecords.id).toBeDefined()
    expect(paymentRecords.orgId).toBeDefined()
    expect(paymentRecords.projectId).toBeDefined()
    expect(paymentRecords.name).toBeDefined()
    expect(paymentRecords.url).toBeDefined()
    expect(paymentRecords.renewalDate).toBeDefined()
    expect(paymentRecords.alertLeadDays).toBeDefined()
    expect(paymentRecords.notifiedLeadDays).toBeDefined()
    expect(paymentRecords.createdBy).toBeDefined()
    expect(paymentRecords.createdAt).toBeDefined()
    expect(paymentRecords.updatedAt).toBeDefined()
  })
})

describe('cert_records schema', () => {
  it('exposes org-scoped cert_records columns', () => {
    expect(certRecords.id).toBeDefined()
    expect(certRecords.orgId).toBeDefined()
    expect(certRecords.projectId).toBeDefined()
    expect(certRecords.domain).toBeDefined()
    expect(certRecords.expiresAt).toBeDefined()
    expect(certRecords.alertLeadDays).toBeDefined()
    expect(certRecords.notifiedLeadDays).toBeDefined()
    expect(certRecords.createdBy).toBeDefined()
    expect(certRecords.createdAt).toBeDefined()
    expect(certRecords.updatedAt).toBeDefined()
  })
})

describe('domain_records schema', () => {
  it('exposes org-scoped domain_records columns', () => {
    expect(domainRecords.id).toBeDefined()
    expect(domainRecords.orgId).toBeDefined()
    expect(domainRecords.projectId).toBeDefined()
    expect(domainRecords.domainName).toBeDefined()
    expect(domainRecords.renewalDate).toBeDefined()
    expect(domainRecords.alertLeadDays).toBeDefined()
    expect(domainRecords.notifiedLeadDays).toBeDefined()
    expect(domainRecords.createdBy).toBeDefined()
    expect(domainRecords.createdAt).toBeDefined()
    expect(domainRecords.updatedAt).toBeDefined()
  })
})

describe('Story 6.1 monitoring tables remain subject to RLS coverage', () => {
  it('does not exclude payment_records/cert_records/domain_records from RLS coverage checks', () => {
    expect(EXCLUDED_TABLES.has('payment_records')).toBe(false)
    expect(EXCLUDED_TABLES.has('cert_records')).toBe(false)
    expect(EXCLUDED_TABLES.has('domain_records')).toBe(false)
  })
})

describe('service_endpoints schema (Story 6.2 ADR-6.2-01)', () => {
  it('exposes org+project-scoped service_endpoints columns', () => {
    expect(serviceEndpoints.id).toBeDefined()
    expect(serviceEndpoints.orgId).toBeDefined()
    expect(serviceEndpoints.projectId).toBeDefined()
    expect(serviceEndpoints.name).toBeDefined()
    expect(serviceEndpoints.url).toBeDefined()
    expect(serviceEndpoints.checkFrequencyMinutes).toBeDefined()
    expect(serviceEndpoints.downThresholdFailures).toBeDefined()
    expect(serviceEndpoints.status).toBeDefined()
    expect(serviceEndpoints.consecutiveFailures).toBeDefined()
    expect(serviceEndpoints.lastCheckedAt).toBeDefined()
    expect(serviceEndpoints.downEpisodeStartedAt).toBeDefined()
    expect(serviceEndpoints.createdBy).toBeDefined()
    expect(serviceEndpoints.createdAt).toBeDefined()
    expect(serviceEndpoints.updatedAt).toBeDefined()
  })
})

describe('endpoint_health_checks schema (Story 6.2 AC 4, ADR-6.2-12)', () => {
  it('exposes append-only endpoint_health_checks columns including failureReason', () => {
    expect(endpointHealthChecks.id).toBeDefined()
    expect(endpointHealthChecks.serviceEndpointId).toBeDefined()
    expect(endpointHealthChecks.orgId).toBeDefined()
    expect(endpointHealthChecks.isHealthy).toBeDefined()
    expect(endpointHealthChecks.statusCode).toBeDefined()
    expect(endpointHealthChecks.latencyMs).toBeDefined()
    expect(endpointHealthChecks.failureReason).toBeDefined()
    expect(endpointHealthChecks.checkedAt).toBeDefined()
  })
})

describe('monitoring_alerts schema (Story 6.2 ADR-6.2-04/05)', () => {
  it('exposes project-scoped monitoring_alerts columns including episodeKey/snoozedUntil', () => {
    expect(monitoringAlerts.id).toBeDefined()
    expect(monitoringAlerts.orgId).toBeDefined()
    expect(monitoringAlerts.projectId).toBeDefined()
    expect(monitoringAlerts.serviceEndpointId).toBeDefined()
    expect(monitoringAlerts.alertType).toBeDefined()
    expect(monitoringAlerts.severity).toBeDefined()
    expect(monitoringAlerts.episodeKey).toBeDefined()
    expect(monitoringAlerts.status).toBeDefined()
    expect(monitoringAlerts.snoozedUntil).toBeDefined()
    expect(monitoringAlerts.dismissedBy).toBeDefined()
    expect(monitoringAlerts.dismissedAt).toBeDefined()
    expect(monitoringAlerts.payload).toBeDefined()
    expect(monitoringAlerts.createdAt).toBeDefined()
    expect(monitoringAlerts.updatedAt).toBeDefined()
  })
})

describe('Story 6.2 new tables remain subject to RLS coverage', () => {
  it('does not exclude service_endpoints/endpoint_health_checks/monitoring_alerts', () => {
    expect(EXCLUDED_TABLES.has('service_endpoints')).toBe(false)
    expect(EXCLUDED_TABLES.has('endpoint_health_checks')).toBe(false)
    expect(EXCLUDED_TABLES.has('monitoring_alerts')).toBe(false)
  })
})
