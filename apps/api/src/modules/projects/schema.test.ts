import { describe, expect, it } from 'vitest'
import { EMPTY_PROJECT_DASHBOARD, ProjectSummarySchema } from '@project-vault/shared'
import {
  CreateProjectBodySchema,
  PatchProjectBodySchema,
  ProjectDashboardResponseSchema,
  ProjectListResponseSchema,
  ProjectParamsSchema,
  ProjectTagUpdateResponseSchema,
  TagArrayBodySchema as ProjectTagArrayBodySchema,
} from './schema.js'

const PROJECT_NAME = 'Payments API'
const ORG_ID = `00000000-0000-4000-8000-${'000000000002'}`
const PROJECT_ID = `00000000-0000-4000-8000-${'000000000010'}`
const TEAM_PAYMENTS_TAG = 'team-payments'
const TIER_0_TAG = 'tier-0'
const PAYMENTS_SLUG = 'payments-api'

describe('project API schemas', () => {
  it.each([PAYMENTS_SLUG, 'abc', 'frontend-prod-v2', 'a1b'])('accepts valid slug %s', (slug) => {
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
        slug: PAYMENTS_SLUG,
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
    // Story 9.3 D8.2/AC-11: page/limit/hasNext are now required fields on this schema.
    const listEnvelope = {
      data: {
        items: [
          {
            id: PROJECT_ID,
            name: PROJECT_NAME,
            slug: PAYMENTS_SLUG,
            description: null,
            role: 'owner',
            credentialCount: 0,
            expiringCount: 0,
            alertCount: 0,
            tags: [TEAM_PAYMENTS_TAG],
            createdAt: new Date().toISOString(),
            archivedAt: null,
            isArchived: false,
          },
        ],
        total: 1,
        page: 1,
        limit: 20,
        hasNext: false,
      },
    }
    expect(ProjectListResponseSchema.parse(listEnvelope)).toEqual(listEnvelope)
    expect(
      ProjectDashboardResponseSchema.parse({
        data: EMPTY_PROJECT_DASHBOARD,
      })
    ).toMatchObject({ data: { isEmpty: true } })
  })

  // AC-P1: ProjectSummary gains a strictly additive `tags` field — a project with no tags
  // returns `[]`, matching projects.tags's existing non-null jsonb-array default.
  it('AC-P1: ProjectSummarySchema requires tags: string[], defaulting to [] semantics enforced by callers', () => {
    const base = {
      id: PROJECT_ID,
      name: PROJECT_NAME,
      slug: PAYMENTS_SLUG,
      description: null,
      role: 'owner' as const,
      credentialCount: 0,
      expiringCount: 0,
      alertCount: 0,
      createdAt: new Date().toISOString(),
      archivedAt: null,
      isArchived: false,
    }
    expect(ProjectSummarySchema.parse({ ...base, tags: ['payments', 'stripe'] })).toMatchObject({
      tags: ['payments', 'stripe'],
    })
    expect(ProjectSummarySchema.parse({ ...base, tags: [] })).toMatchObject({ tags: [] })
    expect(() => ProjectSummarySchema.parse(base)).toThrow()
  })

  it('reuses the shared tag body schema and parses project tag responses', () => {
    expect(
      ProjectTagArrayBodySchema.parse({ tags: [` ${TEAM_PAYMENTS_TAG} `, TIER_0_TAG] })
    ).toEqual({
      tags: [TEAM_PAYMENTS_TAG, TIER_0_TAG],
    })
    expect(() => ProjectTagArrayBodySchema.parse({ tags: [' '] })).toThrow()
    expect(
      ProjectTagUpdateResponseSchema.parse({
        data: { id: PROJECT_ID, tags: [TEAM_PAYMENTS_TAG, TIER_0_TAG] },
      })
    ).toEqual({ data: { id: PROJECT_ID, tags: [TEAM_PAYMENTS_TAG, TIER_0_TAG] } })
  })
})
