import { describe, expect, it } from 'vitest'
import {
  CreateProjectBodySchema,
  PatchProjectBodySchema,
  ProjectDashboardResponseSchema,
  ProjectListResponseSchema,
  ProjectParamsSchema,
} from './schema.js'

const PROJECT_NAME = 'Payments API'
const ORG_ID = `00000000-0000-4000-8000-${'000000000002'}`
const PROJECT_ID = `00000000-0000-4000-8000-${'000000000010'}`

describe('project API schemas', () => {
  it.each(['payments-api', 'abc', 'frontend-prod-v2', 'a1b'])('accepts valid slug %s', (slug) => {
    expect(CreateProjectBodySchema.parse({ name: PROJECT_NAME, slug })).toMatchObject({ slug })
  })

  it.each(['Payments-API', 'pa', 'payments api', '-payments', 'payments-'])(
    'rejects invalid slug %s',
    (slug) => {
      expect(() => CreateProjectBodySchema.parse({ name: PROJECT_NAME, slug })).toThrow(
        /Slug must be 3/
      )
    }
  )

  it('rejects names that are empty after trimming', () => {
    expect(() => CreateProjectBodySchema.parse({ name: '   ', slug: 'blank-name' })).toThrow()
    expect(() => PatchProjectBodySchema.parse({ name: '   ' })).toThrow()
  })

  it('rejects unknown create keys such as orgId', () => {
    expect(() =>
      CreateProjectBodySchema.parse({
        name: PROJECT_NAME,
        slug: 'payments-api',
        orgId: ORG_ID,
      })
    ).toThrow()
  })

  it('strips immutable slug on patch but rejects unknown keys such as orgId', () => {
    expect(PatchProjectBodySchema.parse({ name: 'New Name', slug: 'new-name' })).toEqual({
      name: 'New Name',
    })
    expect(() =>
      PatchProjectBodySchema.parse({
        name: 'New Name',
        orgId: ORG_ID,
      })
    ).toThrow()
  })

  it('accepts nullable patch description and validates project id params', () => {
    expect(PatchProjectBodySchema.parse({ description: null })).toEqual({ description: null })
    expect(ProjectParamsSchema.parse({ projectId: PROJECT_ID })).toEqual({ projectId: PROJECT_ID })
    expect(() => ProjectParamsSchema.parse({ projectId: 'not-a-uuid' })).toThrow()
  })

  it('parses project list and dashboard response envelopes', () => {
    expect(ProjectListResponseSchema.parse({ data: { items: [], total: 0 } })).toEqual({
      data: { items: [], total: 0 },
    })
    expect(
      ProjectDashboardResponseSchema.parse({
        data: {
          credentialStats: { active: 0, expiringSoon: 0, expired: 0 },
          upcomingRotations: [],
          monitoredServiceHealth: { healthy: 0, degraded: 0, down: 0 },
          recentAccessEvents: [],
          unresolvedAlertCount: 0,
          isEmpty: true,
          suggestedActions: ['add_credential', 'add_service', 'import_credentials'],
        },
      })
    ).toMatchObject({ data: { isEmpty: true } })
  })
})
