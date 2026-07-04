import { describe, expect, it } from 'vitest'
import {
  ApiKeyIssuedSchema,
  ApiKeyMetadataSchema,
  MachineUserDetailSchema,
  MachineUserSummarySchema,
  MAX_MACHINE_USER_LIST_OFFSET,
  ScopeBoundarySchema,
} from './machine-users.js'

const MACHINE_USER_ID = `00000000-0000-4000-8000-${'000000000200'}`
const PROJECT_ID = `00000000-0000-4000-8000-${'000000000010'}`
const ORG_ID = `00000000-0000-4000-8000-${'000000000002'}`
const USER_ID = `00000000-0000-4000-8000-${'000000000001'}`
const KEY_ID = `00000000-0000-4000-8000-${'000000000300'}`
const CREATED_AT = '2026-07-04T18:00:00.000Z'
const MACHINE_USER_NAME = 'ci-deploy-bot'

describe('ScopeBoundarySchema', () => {
  it('parses the UX-DR11 scope-boundary block', () => {
    expect(
      ScopeBoundarySchema.parse({
        canAccess: [`credentials in project a1c2 (${MACHINE_USER_NAME})`],
        cannotAccess: ['other projects', 'org settings', 'audit logs'],
      })
    ).toMatchObject({ cannotAccess: ['other projects', 'org settings', 'audit logs'] })
  })
})

describe('MachineUserDetailSchema', () => {
  it('parses a full machine-user detail item including scopeBoundary', () => {
    const parsed = MachineUserDetailSchema.parse({
      id: MACHINE_USER_ID,
      projectId: PROJECT_ID,
      name: MACHINE_USER_NAME,
      description: 'GitHub Actions deploy pipeline',
      role: 'member',
      createdBy: USER_ID,
      createdAt: CREATED_AT,
      deactivatedAt: null,
      scopeBoundary: { canAccess: ['x'], cannotAccess: ['y'] },
    })
    expect(parsed.role).toBe('member')
  })

  it('rejects a role outside member/viewer', () => {
    expect(() =>
      MachineUserDetailSchema.parse({
        id: MACHINE_USER_ID,
        projectId: PROJECT_ID,
        name: MACHINE_USER_NAME,
        description: null,
        role: 'admin',
        createdBy: USER_ID,
        createdAt: CREATED_AT,
        deactivatedAt: null,
        scopeBoundary: { canAccess: [], cannotAccess: [] },
      })
    ).toThrow()
  })
})

describe('MachineUserSummarySchema', () => {
  it('parses a list item without scopeBoundary', () => {
    const parsed = MachineUserSummarySchema.parse({
      id: MACHINE_USER_ID,
      projectId: PROJECT_ID,
      name: MACHINE_USER_NAME,
      description: null,
      role: 'viewer',
      createdBy: USER_ID,
      createdAt: CREATED_AT,
      deactivatedAt: null,
    })
    expect(parsed).not.toHaveProperty('scopeBoundary')
  })
})

describe('ApiKeyIssuedSchema', () => {
  it('parses the plaintext-once key-issue response', () => {
    const parsed = ApiKeyIssuedSchema.parse({
      id: KEY_ID,
      machineUserId: MACHINE_USER_ID,
      name: 'prod-deploy-key',
      key: 'pk_9f3aB7xQ',
      expiresAt: '2027-01-01T00:00:00.000Z',
      createdAt: CREATED_AT,
    })
    expect(parsed.key).toBe('pk_9f3aB7xQ')
  })
})

describe('ApiKeyMetadataSchema', () => {
  it('excludes keyHash/plaintext by construction (structural allowlist, AC-12)', () => {
    const parsed = ApiKeyMetadataSchema.parse({
      id: KEY_ID,
      name: 'prod-deploy-key',
      expiresAt: null,
      lastUsedAt: null,
      createdAt: CREATED_AT,
      isRevoked: false,
      // Extra fields a careless SELECT * might include must be stripped, not passed through.
      keyHash: 'deadbeef',
      key: 'pk_should_not_leak',
      orgId: ORG_ID,
    })
    expect(parsed).not.toHaveProperty('keyHash')
    expect(parsed).not.toHaveProperty('key')
    expect(parsed).not.toHaveProperty('orgId')
  })
})

describe('MAX_MACHINE_USER_LIST_OFFSET', () => {
  it('is a positive integer cap shared by machine-user and api-key list endpoints', () => {
    expect(Number.isInteger(MAX_MACHINE_USER_LIST_OFFSET)).toBe(true)
    expect(MAX_MACHINE_USER_LIST_OFFSET).toBeGreaterThan(0)
  })
})
