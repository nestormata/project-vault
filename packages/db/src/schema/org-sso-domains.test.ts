import { describe, expect, it } from 'vitest'
import { orgSsoDomains } from './index.js'
import { EXCLUDED_TABLES } from '../check-rls-coverage.js'

describe('org_sso_domains schema (Story 14.4)', () => {
  it('exposes the org-scoped domain-mapping columns', () => {
    expect(orgSsoDomains.id).toBeDefined()
    expect(orgSsoDomains.orgId).toBeDefined()
    expect(orgSsoDomains.domain).toBeDefined()
    expect(orgSsoDomains.providerName).toBeDefined()
    expect(orgSsoDomains.createdAt).toBeDefined()
  })

  it('is NOT excluded from RLS coverage (org-scoped, needs a policy) — unlike sso_login_states', () => {
    expect(EXCLUDED_TABLES.has('org_sso_domains')).toBe(false)
  })
})
