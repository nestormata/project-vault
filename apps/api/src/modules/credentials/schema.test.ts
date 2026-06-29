import { describe, expect, it } from 'vitest'
import {
  AddVersionBodySchema,
  CreateCredentialBodySchema,
  CredentialParamsSchema,
  ListCredentialsQuerySchema,
  ListCredentialsResponseSchema,
  MAX_CREDENTIAL_LIST_OFFSET,
  TagArrayBodySchema,
  TagUpdateResponseSchema,
} from './schema.js'

const PROJECT_ID = `00000000-0000-4000-8000-${'000000000010'}`
const CREDENTIAL_ID = `00000000-0000-4000-8000-${'000000000100'}`

describe('credential create body schema', () => {
  it('accepts a minimal valid body', () => {
    expect(
      CreateCredentialBodySchema.parse({ name: 'Stripe Secret Key', value: 'super-secret' })
    ).toMatchObject({ name: 'Stripe Secret Key', value: 'super-secret' })
  })

  it('does not trim the value (whitespace may be significant)', () => {
    expect(
      CreateCredentialBodySchema.parse({ name: 'Key', value: '  padded-value  ' })
    ).toMatchObject({ value: '  padded-value  ' })
  })

  it('rejects an empty value', () => {
    expect(() => CreateCredentialBodySchema.parse({ name: 'Key', value: '' })).toThrow()
  })

  it('rejects a whitespace-only name after trimming', () => {
    expect(() => CreateCredentialBodySchema.parse({ name: '   ', value: 'secret' })).toThrow()
  })

  it('rejects a value over 65536 chars', () => {
    expect(() =>
      CreateCredentialBodySchema.parse({ name: 'Key', value: 'a'.repeat(65537) })
    ).toThrow()
  })

  it('rejects unknown keys (.strict)', () => {
    expect(() =>
      CreateCredentialBodySchema.parse({
        name: 'Key',
        value: 'secret',
        orgId: `00000000-0000-4000-8000-${'000000000002'}`,
      })
    ).toThrow()
  })

  it.each(['0 0 1 * *', '*/5 * * * *', '0 3 * * 1-5'])('accepts valid cron shape %s', (cron) => {
    expect(
      CreateCredentialBodySchema.parse({ name: 'Key', value: 'secret', rotationSchedule: cron })
    ).toMatchObject({ rotationSchedule: cron })
  })

  it('rejects a cron with fewer than 5 fields', () => {
    expect(() =>
      CreateCredentialBodySchema.parse({ name: 'Key', value: 'secret', rotationSchedule: '* * *' })
    ).toThrow()
  })

  it('accepts tags within bounds', () => {
    expect(
      CreateCredentialBodySchema.parse({
        name: 'Key',
        value: 'secret',
        tags: ['payments', 'third-party'],
      })
    ).toMatchObject({ tags: ['payments', 'third-party'] })
  })

  it('rejects more than 20 tags', () => {
    expect(() =>
      CreateCredentialBodySchema.parse({
        name: 'Key',
        value: 'secret',
        tags: Array.from({ length: 21 }, (_, i) => `tag-${i}`),
      })
    ).toThrow()
  })

  it('rejects a tag longer than 50 chars', () => {
    expect(() =>
      CreateCredentialBodySchema.parse({
        name: 'Key',
        value: 'secret',
        tags: ['a'.repeat(51)],
      })
    ).toThrow()
  })
})

describe('add version body schema', () => {
  it('accepts a valid value', () => {
    expect(AddVersionBodySchema.parse({ value: 'rotated-secret' })).toEqual({
      value: 'rotated-secret',
    })
  })

  it('rejects unknown keys', () => {
    expect(() => AddVersionBodySchema.parse({ value: 'secret', extra: 'nope' })).toThrow()
  })

  it('rejects an empty value', () => {
    expect(() => AddVersionBodySchema.parse({ value: '' })).toThrow()
  })
})

describe('credential params schema', () => {
  it('validates projectId and credentialId as UUIDs', () => {
    expect(
      CredentialParamsSchema.parse({ projectId: PROJECT_ID, credentialId: CREDENTIAL_ID })
    ).toEqual({ projectId: PROJECT_ID, credentialId: CREDENTIAL_ID })
    expect(() =>
      CredentialParamsSchema.parse({ projectId: 'not-a-uuid', credentialId: CREDENTIAL_ID })
    ).toThrow()
  })
})

describe('credential list and tag schemas', () => {
  it('coerces list query numerics and applies defaults', () => {
    expect(
      ListCredentialsQuerySchema.parse({
        q: ' stripe ',
        tags: 'payments,prod',
        status: 'expiring',
        expiresWithin: '45',
        page: '2',
        limit: '50',
      })
    ).toEqual({
      q: 'stripe',
      tags: 'payments,prod',
      status: 'expiring',
      expiresWithin: 45,
      page: 2,
      limit: 50,
    })

    expect(ListCredentialsQuerySchema.parse({})).toMatchObject({
      expiresWithin: 30,
      page: 1,
      limit: 20,
    })
    expect(MAX_CREDENTIAL_LIST_OFFSET).toBe(10_000)
  })

  it('rejects unknown list query keys and out-of-range numerics', () => {
    expect(() => ListCredentialsQuerySchema.parse({ includeValues: 'true' })).toThrow()
    expect(() => ListCredentialsQuerySchema.parse({ limit: '101' })).toThrow()
    expect(() => ListCredentialsQuerySchema.parse({ expiresWithin: '0' })).toThrow()
  })

  it('validates tag mutation bodies', () => {
    expect(TagArrayBodySchema.parse({ tags: [' payments ', 'prod'] })).toEqual({
      tags: ['payments', 'prod'],
    })
    expect(() => TagArrayBodySchema.parse({ tags: [' '] })).toThrow()
    expect(() => TagArrayBodySchema.parse({ tags: ['a'.repeat(51)] })).toThrow()
    expect(() =>
      TagArrayBodySchema.parse({ tags: Array.from({ length: 21 }, (_, i) => `tag-${i}`) })
    ).toThrow()
    expect(() => TagArrayBodySchema.parse({ tags: [], orgId: PROJECT_ID })).toThrow()
  })

  it('parses list and tag response envelopes', () => {
    expect(
      ListCredentialsResponseSchema.parse({
        data: {
          items: [],
          total: 0,
          page: 1,
          limit: 20,
          hasNext: false,
        },
      })
    ).toEqual({ data: { items: [], total: 0, page: 1, limit: 20, hasNext: false } })

    expect(TagUpdateResponseSchema.parse({ data: { id: CREDENTIAL_ID, tags: ['prod'] } })).toEqual({
      data: { id: CREDENTIAL_ID, tags: ['prod'] },
    })
  })
})
