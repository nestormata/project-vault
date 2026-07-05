import { describe, expect, it } from 'vitest'
import {
  AbandonRotationBodySchema,
  BreakGlassRotationBodySchema,
  InitiateRotationBodySchema,
  ListRotationsQuerySchema,
  ResumeRotationBodySchema,
  RotationCredentialParamsSchema,
  RotationParamsSchema,
} from './schema.js'

const PROJECT_ID = `00000000-0000-4000-8000-${'000000000010'}`
const CREDENTIAL_ID = `00000000-0000-4000-8000-${'000000000020'}`
const ROTATION_ID = `00000000-0000-4000-8000-${'000000000099'}`

describe('initiate rotation body schema', () => {
  it('accepts a minimal valid body', () => {
    expect(InitiateRotationBodySchema.parse({ newValue: 'sk_live_rotated' })).toMatchObject({
      newValue: 'sk_live_rotated',
      notes: null,
    })
  })

  it('accepts notes and trims them', () => {
    expect(
      InitiateRotationBodySchema.parse({ newValue: 'sk_live_rotated', notes: '  rotated  ' })
    ).toMatchObject({ notes: 'rotated' })
  })

  it('normalizes a whitespace-only notes string to null', () => {
    expect(
      InitiateRotationBodySchema.parse({ newValue: 'sk_live_rotated', notes: '   ' })
    ).toMatchObject({ notes: null })
  })

  it('rejects a missing newValue', () => {
    expect(() => InitiateRotationBodySchema.parse({})).toThrow()
  })

  it('rejects an empty newValue', () => {
    expect(() => InitiateRotationBodySchema.parse({ newValue: '' })).toThrow()
  })

  it('rejects a newValue over 65536 chars', () => {
    expect(() => InitiateRotationBodySchema.parse({ newValue: 'x'.repeat(65537) })).toThrow()
  })

  it('rejects unknown keys (.strict)', () => {
    expect(() => InitiateRotationBodySchema.parse({ newValue: 'ok', extraField: true })).toThrow()
  })

  it('rejects a non-string newValue', () => {
    expect(() => InitiateRotationBodySchema.parse({ newValue: 12345 })).toThrow()
  })

  it('rejects notes exceeding 1024 chars', () => {
    expect(() =>
      InitiateRotationBodySchema.parse({ newValue: 'ok', notes: 'x'.repeat(1025) })
    ).toThrow()
  })
})

describe('rotation params schemas', () => {
  it('validates projectId/credentialId/rotationId as UUIDs', () => {
    expect(
      RotationParamsSchema.parse({
        projectId: PROJECT_ID,
        credentialId: CREDENTIAL_ID,
        rotationId: ROTATION_ID,
      })
    ).toEqual({ projectId: PROJECT_ID, credentialId: CREDENTIAL_ID, rotationId: ROTATION_ID })
  })

  it('rejects a malformed (non-UUID) rotationId', () => {
    expect(() =>
      RotationParamsSchema.parse({
        projectId: PROJECT_ID,
        credentialId: CREDENTIAL_ID,
        rotationId: 'not-a-uuid',
      })
    ).toThrow()
  })

  it('rejects a malformed (non-UUID) credentialId on the credential-scoped params', () => {
    expect(() =>
      RotationCredentialParamsSchema.parse({ projectId: PROJECT_ID, credentialId: 'nope' })
    ).toThrow()
  })
})

describe('break-glass rotation body schema (Story 5.3 AC-4)', () => {
  it('accepts a minimal valid body with a required reason', () => {
    expect(
      BreakGlassRotationBodySchema.parse({ newValue: 'sk_live_emergency', reason: 'incident' })
    ).toMatchObject({ newValue: 'sk_live_emergency', reason: 'incident' })
  })

  it('rejects a missing newValue and/or reason', () => {
    expect(() => BreakGlassRotationBodySchema.parse({})).toThrow()
    expect(() => BreakGlassRotationBodySchema.parse({ newValue: 'x' })).toThrow()
  })

  it('rejects an empty/whitespace-only reason', () => {
    expect(() => BreakGlassRotationBodySchema.parse({ newValue: 'x', reason: '' })).toThrow()
    expect(() => BreakGlassRotationBodySchema.parse({ newValue: 'x', reason: '   ' })).toThrow()
  })

  it('rejects an empty newValue', () => {
    expect(() => BreakGlassRotationBodySchema.parse({ newValue: '', reason: 'incident' })).toThrow()
  })

  it('rejects an oversized newValue or reason', () => {
    expect(() =>
      BreakGlassRotationBodySchema.parse({ newValue: 'x'.repeat(65537), reason: 'incident' })
    ).toThrow()
    expect(() =>
      BreakGlassRotationBodySchema.parse({ newValue: 'x', reason: 'x'.repeat(1025) })
    ).toThrow()
  })

  it('rejects unknown keys (.strict)', () => {
    expect(() =>
      BreakGlassRotationBodySchema.parse({ newValue: 'x', reason: 'incident', extra: true })
    ).toThrow()
  })
})

describe('resume/abandon rotation body schemas (Story 5.3 AC-11/AC-12)', () => {
  it('accepts only an empty object', () => {
    expect(ResumeRotationBodySchema.parse({})).toEqual({})
    expect(() => ResumeRotationBodySchema.parse({ anything: true })).toThrow()
    expect(AbandonRotationBodySchema.parse({})).toEqual({})
    expect(() => AbandonRotationBodySchema.parse({ anything: true })).toThrow()
  })
})

describe('list rotations query schema', () => {
  it('applies pagination defaults', () => {
    expect(ListRotationsQuerySchema.parse({})).toEqual({ page: 1, limit: 20 })
  })

  it('coerces page/limit numerics', () => {
    expect(ListRotationsQuerySchema.parse({ page: '2', limit: '50' })).toEqual({
      page: 2,
      limit: 50,
    })
  })

  it('rejects unknown query keys', () => {
    expect(() => ListRotationsQuerySchema.parse({ status: 'in_progress' })).toThrow()
  })
})
