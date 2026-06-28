import { describe, expect, it } from 'vitest'
import {
  AddVersionBodySchema,
  CreateCredentialBodySchema,
  CredentialParamsSchema,
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
