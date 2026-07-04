import { describe, expect, it } from 'vitest'
import { paymentRecords, certRecords, domainRecords } from './index.js'
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
