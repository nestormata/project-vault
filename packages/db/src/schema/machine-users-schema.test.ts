import { describe, expect, it } from 'vitest'
import { apiKeys, machineUsers } from './index.js'
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
