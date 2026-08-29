import { describe, expect, it } from 'vitest'
import {
  CredentialArchiveStateSchema,
  CredentialDetailSchema,
  CredentialStatusSchema,
  CredentialSummarySchema,
  CredentialValueSchema,
  CredentialVersionSummarySchema,
} from './credentials.js'

const CREDENTIAL_ID = `00000000-0000-4000-8000-${'000000000100'}`
const PROJECT_ID = `00000000-0000-4000-8000-${'000000000010'}`
const ORG_ID = `00000000-0000-4000-8000-${'000000000002'}`
const USER_ID = `00000000-0000-4000-8000-${'000000000001'}`
const CREATED_AT = '2026-06-27T20:00:00.000Z'
const CREDENTIAL_NAME = 'Stripe Secret Key'

describe('credential response schemas', () => {
  it('parses a credential detail response item', () => {
    expect(
      CredentialDetailSchema.parse({
        id: CREDENTIAL_ID,
        projectId: PROJECT_ID,
        orgId: ORG_ID,
        name: CREDENTIAL_NAME,
        description: 'Production Stripe API secret',
        tags: ['payments', 'third-party'],
        expiresAt: null,
        rotationSchedule: null,
        cacheable: true,
        retentionCount: 3,
        currentVersionNumber: 1,
        schemaVersion: 2,
        fields: [{ key: 'value', sensitive: true }],
        visibleFieldValues: {},
        createdBy: USER_ID,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        archivedAt: null,
      })
    ).toMatchObject({ name: CREDENTIAL_NAME, currentVersionNumber: 1 })
  })

  it('parses a metadata-only credential summary item', () => {
    const parsed = CredentialSummarySchema.parse({
      id: CREDENTIAL_ID,
      projectId: PROJECT_ID,
      name: CREDENTIAL_NAME,
      description: 'Production Stripe API secret',
      tags: ['payments', 'third-party'],
      status: 'expiring',
      expiresAt: '2026-07-20T23:59:59.000Z',
      rotationSchedule: '0 0 1 * *',
      currentVersionNumber: 2,
      hasDependencies: false,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      activeRotation: null,
      archivedAt: null,
    })

    expect(parsed).toMatchObject({ name: CREDENTIAL_NAME, status: 'expiring' })
    expect(parsed).not.toHaveProperty('orgId')
    expect(parsed).not.toHaveProperty('value')
    expect(parsed).not.toHaveProperty('encryptedValue')
  })

  it('rejects invalid credential status values', () => {
    expect(CredentialStatusSchema.parse('active')).toBe('active')
    expect(() => CredentialStatusSchema.parse('rotating')).toThrow()
  })

  it('rejects a retentionCount below 1', () => {
    expect(() =>
      CredentialDetailSchema.parse({
        id: CREDENTIAL_ID,
        projectId: PROJECT_ID,
        orgId: ORG_ID,
        name: CREDENTIAL_NAME,
        description: null,
        tags: [],
        expiresAt: null,
        rotationSchedule: null,
        cacheable: true,
        retentionCount: 0,
        currentVersionNumber: 1,
        schemaVersion: 1,
        fields: [{ key: 'value', sensitive: true }],
        createdBy: null,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      })
    ).toThrow()
  })

  it('parses a credential value reveal response', () => {
    expect(
      CredentialValueSchema.parse({
        value: 'super-secret',
        versionNumber: 1,
        retrievedAt: CREATED_AT,
      })
    ).toMatchObject({ value: 'super-secret', versionNumber: 1 })
  })

  it('parses a version summary item with purgedAt set', () => {
    expect(
      CredentialVersionSummarySchema.parse({
        versionNumber: 1,
        createdBy: USER_ID,
        createdAt: CREATED_AT,
        isCurrent: false,
        purgedAt: CREATED_AT,
        abandonedAt: null,
        schemaVersion: 1,
      })
    ).toMatchObject({ isCurrent: false, purgedAt: CREATED_AT })
  })

  it('rejects a non-positive version number', () => {
    expect(() =>
      CredentialVersionSummarySchema.parse({
        versionNumber: 0,
        createdBy: null,
        createdAt: CREATED_AT,
        isCurrent: false,
        purgedAt: null,
        abandonedAt: null,
      })
    ).toThrow()
  })

  it('parses a Story 5.3 version summary item with abandonedAt set', () => {
    expect(
      CredentialVersionSummarySchema.parse({
        versionNumber: 2,
        createdBy: USER_ID,
        createdAt: CREATED_AT,
        isCurrent: false,
        purgedAt: null,
        abandonedAt: CREATED_AT,
        schemaVersion: 2,
      })
    ).toMatchObject({ isCurrent: false, abandonedAt: CREATED_AT })
  })

  // Story 28.5 AC2/AC3.
  it('parses an archived and an active CredentialArchiveState', () => {
    expect(
      CredentialArchiveStateSchema.parse({
        id: CREDENTIAL_ID,
        name: CREDENTIAL_NAME,
        archivedAt: CREATED_AT,
        isArchived: true,
      })
    ).toMatchObject({ isArchived: true })

    expect(
      CredentialArchiveStateSchema.parse({
        id: CREDENTIAL_ID,
        name: CREDENTIAL_NAME,
        archivedAt: null,
        isArchived: false,
      })
    ).toMatchObject({ isArchived: false })
  })
})
