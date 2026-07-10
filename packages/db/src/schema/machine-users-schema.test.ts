import { describe, expect, it } from 'vitest'
import { apiKeys, credentials, machineUsers, organizations, securityAlerts } from './index.js'
import { EXCLUDED_TABLES } from '../check-rls-coverage.js'

describe('machine_users schema', () => {
  it('exposes org+project-scoped machine_users columns', () => {
    expect(machineUsers.id).toBeDefined()
    expect(machineUsers.orgId).toBeDefined()
    expect(machineUsers.projectId).toBeDefined()
    expect(machineUsers.name).toBeDefined()
    expect(machineUsers.description).toBeDefined()
    expect(machineUsers.role).toBeDefined()
    expect(machineUsers.createdBy).toBeDefined()
    expect(machineUsers.createdAt).toBeDefined()
    expect(machineUsers.deactivatedAt).toBeDefined()
  })
})

describe('api_keys schema', () => {
  it('exposes org-scoped api_keys columns', () => {
    expect(apiKeys.id).toBeDefined()
    expect(apiKeys.orgId).toBeDefined()
    expect(apiKeys.machineUserId).toBeDefined()
    expect(apiKeys.name).toBeDefined()
    expect(apiKeys.keyHash).toBeDefined()
    expect(apiKeys.hmacKeyVersion).toBeDefined()
    expect(apiKeys.expiresAt).toBeDefined()
    expect(apiKeys.lastUsedAt).toBeDefined()
    expect(apiKeys.alertLeadDays).toBeDefined()
    expect(apiKeys.notifiedLeadDays).toBeDefined()
    expect(apiKeys.createdAt).toBeDefined()
    expect(apiKeys.revokedAt).toBeDefined()
  })
})

describe('Story 7.1 machine-user tables remain subject to RLS coverage', () => {
  it('does not exclude machine_users/api_keys from RLS coverage checks', () => {
    expect(EXCLUDED_TABLES.has('machine_users')).toBe(false)
    expect(EXCLUDED_TABLES.has('api_keys')).toBe(false)
  })
})

// Story 7.2 AC-1 — additive rotation/dormancy columns on api_keys, dormancy threshold on
// organizations, cacheable on credentials. No existing column is altered.
describe('api_keys schema — Story 7.2 rotation/dormancy columns', () => {
  it('exposes overlapExpiresAt, rotatedFromKeyId, dormancySnoozedUntil, overlapAlertSent', () => {
    expect(apiKeys.overlapExpiresAt).toBeDefined()
    expect(apiKeys.rotatedFromKeyId).toBeDefined()
    expect(apiKeys.dormancySnoozedUntil).toBeDefined()
    expect(apiKeys.overlapAlertSent).toBeDefined()
  })
})

describe('organizations schema — Story 7.2 dormancy threshold', () => {
  it('exposes machineKeyDormancyThresholdDays', () => {
    expect(organizations.machineKeyDormancyThresholdDays).toBeDefined()
  })
})

describe('credentials schema — Story 7.2 cacheable flag', () => {
  it('exposes cacheable', () => {
    expect(credentials.cacheable).toBeDefined()
  })
})

describe('credentials schema — Story 3.5 expiry alerts', () => {
  it('exposes alertLeadDays and notifiedLeadDays', () => {
    expect(credentials.alertLeadDays).toBeDefined()
    expect(credentials.notifiedLeadDays).toBeDefined()
  })
})

describe('security_alerts schema — Story 7.2 dormancy dedupe index', () => {
  it('still exposes payload/status/alertType used by the dormancy dedupe query', () => {
    expect(securityAlerts.payload).toBeDefined()
    expect(securityAlerts.status).toBeDefined()
    expect(securityAlerts.alertType).toBeDefined()
  })
})
