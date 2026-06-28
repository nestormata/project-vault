import { describe, expect, it } from 'vitest'
import { ProjectDetailSchema, ProjectRoleSchema, ProjectSummarySchema } from './projects.js'

const PROJECT_ID = `00000000-0000-4000-8000-${'000000000010'}`
const ORG_ID = `00000000-0000-4000-8000-${'000000000002'}`
const PROJECT_NAME = 'Payments API'
const PROJECT_SLUG = 'payments-api'
const CREATED_AT = '2026-07-01T00:00:00.000Z'

describe('project response schemas', () => {
  it('accepts supported project roles', () => {
    expect(ProjectRoleSchema.options).toEqual(['owner', 'admin', 'member', 'viewer'])
  })

  it('parses a project summary response item', () => {
    expect(
      ProjectSummarySchema.parse({
        id: PROJECT_ID,
        name: PROJECT_NAME,
        slug: PROJECT_SLUG,
        description: 'Payment service credentials',
        role: 'owner',
        credentialCount: 0,
        expiringCount: 0,
        alertCount: 0,
        createdAt: CREATED_AT,
      })
    ).toMatchObject({ slug: PROJECT_SLUG, credentialCount: 0 })
  })

  it('parses a project detail response item with nullable fields', () => {
    expect(
      ProjectDetailSchema.parse({
        id: PROJECT_ID,
        orgId: ORG_ID,
        name: PROJECT_NAME,
        slug: PROJECT_SLUG,
        description: null,
        role: 'owner',
        createdBy: null,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        archivedAt: null,
      })
    ).toMatchObject({ description: null, createdBy: null })
  })

  it('rejects negative summary counts', () => {
    expect(() =>
      ProjectSummarySchema.parse({
        id: PROJECT_ID,
        name: PROJECT_NAME,
        slug: PROJECT_SLUG,
        description: null,
        role: 'owner',
        credentialCount: -1,
        expiringCount: 0,
        alertCount: 0,
        createdAt: CREATED_AT,
      })
    ).toThrow()
  })
})
