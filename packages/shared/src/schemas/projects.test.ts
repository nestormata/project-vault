import { describe, expect, it } from 'vitest'
import {
  ProjectArchiveStateSchema,
  DeletedProjectSchema,
  ProjectDetailSchema,
  ProjectOverviewSchema,
  ProjectUrlsSchema,
  PROJECT_URLS_MAX,
  ProjectRoleSchema,
  ProjectSummarySchema,
} from './projects.js'

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
        tags: [],
        createdAt: CREATED_AT,
        archivedAt: null,
        isArchived: false,
      })
    ).toMatchObject({ slug: PROJECT_SLUG, credentialCount: 0 })
  })

  it('parses an archived project summary item (AC-3)', () => {
    expect(
      ProjectSummarySchema.parse({
        id: PROJECT_ID,
        name: PROJECT_NAME,
        slug: PROJECT_SLUG,
        description: null,
        role: 'owner',
        credentialCount: 0,
        expiringCount: 0,
        alertCount: 0,
        tags: [],
        createdAt: CREATED_AT,
        archivedAt: CREATED_AT,
        isArchived: true,
      })
    ).toMatchObject({ archivedAt: CREATED_AT, isArchived: true })
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
        tags: [],
        createdAt: CREATED_AT,
        archivedAt: null,
        isArchived: false,
      })
    ).toThrow()
  })

  it('parses an archive/unarchive response state (AC-8)', () => {
    expect(
      ProjectArchiveStateSchema.parse({
        id: PROJECT_ID,
        name: PROJECT_NAME,
        slug: PROJECT_SLUG,
        archivedAt: CREATED_AT,
        isArchived: true,
      })
    ).toMatchObject({ isArchived: true })

    expect(
      ProjectArchiveStateSchema.parse({
        id: PROJECT_ID,
        name: PROJECT_NAME,
        slug: PROJECT_SLUG,
        archivedAt: null,
        isArchived: false,
      })
    ).toMatchObject({ isArchived: false })
  })
})

describe('ProjectUrlsSchema (72-9)', () => {
  it('trims and accepts http and https URLs, and an empty list', () => {
    expect(ProjectUrlsSchema.parse([])).toEqual([])
    expect(
      ProjectUrlsSchema.parse(['  https://example.com/a?b=1  ', 'http://intranet.example.org'])
    ).toEqual(['https://example.com/a?b=1', 'http://intranet.example.org/'])
  })

  it('stores the parsed form, so a scheme-relative oddity cannot hide a bad link', () => {
    expect(ProjectUrlsSchema.parse(['http:example.com'])).toEqual(['http://example.com/'])
    expect(
      ProjectUrlsSchema.safeParse(['https://example.com/a', 'HTTPS://EXAMPLE.COM/a']).success
    ).toBe(false)
  })

  it.each([
    ['javascript scheme', 'javascript:alert(1)'],
    ['data scheme', 'data:text/html,x'],
    ['file scheme', 'file:///etc/passwd'],
    ['relative', '/projects/1'],
    ['not a URL', 'not a url'],
    ['embedded credentials', 'https://user:pass@example.com'],
    ['empty', '   '],
  ])('rejects %s', (_label, value) => {
    expect(ProjectUrlsSchema.safeParse([value]).success).toBe(false)
  })

  it('rejects an over-long URL, too many entries and case-insensitive duplicates', () => {
    expect(ProjectUrlsSchema.safeParse([`https://example.com/${'a'.repeat(2048)}`]).success).toBe(
      false
    )
    const many = Array.from({ length: PROJECT_URLS_MAX + 1 }, (_, i) => `https://example.com/${i}`)
    expect(ProjectUrlsSchema.safeParse(many).success).toBe(false)
    expect(
      ProjectUrlsSchema.safeParse(['https://Example.com/a', 'https://example.com/a']).success
    ).toBe(false)
  })
})

describe('72-9 response schemas', () => {
  it('requires urls on the project overview', () => {
    const base = {
      id: PROJECT_ID,
      orgId: ORG_ID,
      name: PROJECT_NAME,
      slug: PROJECT_SLUG,
      description: null,
      role: 'owner',
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      archivedAt: null,
      createdBy: null,
      tags: [],
      memberCount: 1,
    }
    expect(
      ProjectOverviewSchema.safeParse({ ...base, urls: ['https://example.com'] }).success
    ).toBe(true)
    expect(ProjectOverviewSchema.safeParse(base).success).toBe(false)
  })

  it('parses a deleted project item', () => {
    expect(
      DeletedProjectSchema.parse({
        id: PROJECT_ID,
        name: PROJECT_NAME,
        slug: PROJECT_SLUG,
        deletedAt: CREATED_AT,
        purgeAfter: '2026-07-31T00:00:00.000Z',
      }).slug
    ).toBe(PROJECT_SLUG)
  })
})
