import { describe, expect, it } from 'vitest'
import {
  serializeCertificateRecord,
  serializeDomainRecord,
  serializeHealthCheck,
  serializeMonitoringAlert,
  serializePaymentRecord,
  serializeServiceEndpoint,
} from './service.js'

const EXAMPLE_COM = 'example.com'
const CHECKED_AT = new Date('2026-01-01T00:00:00.000Z')
const DEC_2026_ISO = '2026-12-01T00:00:00.000Z'
const DEC_2026 = new Date(DEC_2026_ISO)
const ROW_ID = 'row-1'
const ORG_ID = 'org-1'
const USER_ID = 'user-1'
const HEALTHY_STATUS = 'healthy'
const SVC_ID = 'svc-1'
const API_NAME = 'API'

const BASE_ROW_FIELDS = {
  id: ROW_ID,
  orgId: ORG_ID,
  projectId: 'proj-1',
  alertLeadDays: [7, 30],
  notifiedLeadDays: [],
  createdBy: USER_ID,
  createdAt: CHECKED_AT,
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
}

describe('serializePaymentRecord', () => {
  it('formats renewalDate as ISO when present', () => {
    const result = serializePaymentRecord({
      ...BASE_ROW_FIELDS,
      name: 'Stripe',
      url: 'https://stripe.com',
      renewalDate: new Date('2026-06-01T00:00:00.000Z'),
    } as Parameters<typeof serializePaymentRecord>[0])
    expect(result.renewalDate).toBe('2026-06-01T00:00:00.000Z')
  })

  it('falls back to null when renewalDate is unset', () => {
    const result = serializePaymentRecord({
      ...BASE_ROW_FIELDS,
      name: 'Stripe',
      url: 'https://stripe.com',
      renewalDate: null,
    } as Parameters<typeof serializePaymentRecord>[0])
    expect(result.renewalDate).toBeNull()
  })
})

describe('serializeCertificateRecord', () => {
  it('formats expiresAt as ISO when present, null when unset', () => {
    const withDate = serializeCertificateRecord({
      ...BASE_ROW_FIELDS,
      domain: EXAMPLE_COM,
      expiresAt: DEC_2026,
    } as Parameters<typeof serializeCertificateRecord>[0])
    expect(withDate.expiresAt).toBe(DEC_2026_ISO)

    const withoutDate = serializeCertificateRecord({
      ...BASE_ROW_FIELDS,
      domain: EXAMPLE_COM,
      expiresAt: null,
    } as Parameters<typeof serializeCertificateRecord>[0])
    expect(withoutDate.expiresAt).toBeNull()
  })
})

describe('serializeDomainRecord', () => {
  it('formats renewalDate as ISO when present, null when unset', () => {
    const withDate = serializeDomainRecord({
      ...BASE_ROW_FIELDS,
      domainName: EXAMPLE_COM,
      renewalDate: DEC_2026,
    } as Parameters<typeof serializeDomainRecord>[0])
    expect(withDate.renewalDate).toBe(DEC_2026_ISO)

    const withoutDate = serializeDomainRecord({
      ...BASE_ROW_FIELDS,
      domainName: EXAMPLE_COM,
      renewalDate: null,
    } as Parameters<typeof serializeDomainRecord>[0])
    expect(withoutDate.renewalDate).toBeNull()
  })
})

describe('serializeServiceEndpoint', () => {
  it('formats lastCheckedAt as ISO when present, null when unset, and redacts the URL', () => {
    const withDate = serializeServiceEndpoint({
      ...BASE_ROW_FIELDS,
      name: API_NAME,
      url: 'https://user:pass@example.com/health',
      checkFrequencyMinutes: 5,
      downThresholdFailures: 3,
      status: HEALTHY_STATUS,
      consecutiveFailures: 0,
      lastCheckedAt: new Date('2026-01-05T00:00:00.000Z'),
      downEpisodeStartedAt: null,
    } as Parameters<typeof serializeServiceEndpoint>[0])
    expect(withDate.lastCheckedAt).toBe('2026-01-05T00:00:00.000Z')
    expect(withDate.url).not.toContain('user:pass')

    const withoutDate = serializeServiceEndpoint({
      ...BASE_ROW_FIELDS,
      name: API_NAME,
      url: 'https://example.com/health',
      checkFrequencyMinutes: 5,
      downThresholdFailures: 3,
      status: HEALTHY_STATUS,
      consecutiveFailures: 0,
      lastCheckedAt: null,
      downEpisodeStartedAt: null,
    } as Parameters<typeof serializeServiceEndpoint>[0])
    expect(withoutDate.lastCheckedAt).toBeNull()
  })
})

function healthCheckRow(
  overrides: Record<string, unknown>
): Parameters<typeof serializeHealthCheck>[0] {
  return {
    id: 'check-1',
    orgId: ORG_ID,
    serviceEndpointId: SVC_ID,
    isHealthy: true,
    statusCode: 200,
    latencyMs: 42,
    failureReason: null,
    checkedAt: CHECKED_AT,
    ...overrides,
  } as unknown as Parameters<typeof serializeHealthCheck>[0]
}

describe('serializeHealthCheck', () => {
  it('passes through a null failureReason for a healthy check', () => {
    const result = serializeHealthCheck(healthCheckRow({}))
    expect(result.failureReason).toBeNull()
    expect(result.isHealthy).toBe(true)
  })

  it('passes through a failureReason for a failed check', () => {
    const result = serializeHealthCheck(
      healthCheckRow({
        isHealthy: false,
        statusCode: null,
        latencyMs: null,
        failureReason: 'timeout',
      })
    )
    expect(result.failureReason).toBe('timeout')
  })
})

describe('serializeMonitoringAlert', () => {
  it('formats snoozedUntil/dismissedAt as ISO when present', () => {
    const result = serializeMonitoringAlert({
      id: 'alert-1',
      alertType: 'service.down',
      severity: 'critical',
      status: 'snoozed',
      episodeKey: 'ep-1',
      serviceEndpointId: SVC_ID,
      snoozedUntil: new Date('2026-01-10T00:00:00.000Z'),
      dismissedBy: USER_ID,
      dismissedAt: new Date('2026-01-11T00:00:00.000Z'),
      createdAt: CHECKED_AT,
    } as Parameters<typeof serializeMonitoringAlert>[0])
    expect(result.snoozedUntil).toBe('2026-01-10T00:00:00.000Z')
    expect(result.dismissedAt).toBe('2026-01-11T00:00:00.000Z')
  })

  it('falls back to null when snoozedUntil/dismissedAt are unset', () => {
    const result = serializeMonitoringAlert({
      id: 'alert-1',
      alertType: 'service.down',
      severity: 'critical',
      status: 'active',
      episodeKey: 'ep-1',
      serviceEndpointId: SVC_ID,
      snoozedUntil: null,
      dismissedBy: null,
      dismissedAt: null,
      createdAt: CHECKED_AT,
    } as Parameters<typeof serializeMonitoringAlert>[0])
    expect(result.snoozedUntil).toBeNull()
    expect(result.dismissedAt).toBeNull()
  })
})
