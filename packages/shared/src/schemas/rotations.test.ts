import { describe, expect, it } from 'vitest'
import {
  CompleteRotationBodySchema,
  ConfirmChecklistItemBodySchema,
  FailChecklistItemBodySchema,
  RetryChecklistItemBodySchema,
  RotationChecklistItemSchema,
  RotationChecklistItemStatusSchema,
  RotationDetailSchema,
  RotationStatusSchema,
  RotationSummarySchema,
  UpcomingRotationsQuerySchema,
} from './rotations.js'

const ROTATION_ID = `00000000-0000-4000-8000-${'000000000099'}`
const CREDENTIAL_ID = `00000000-0000-4000-8000-${'000000000020'}`
const PROJECT_ID = `00000000-0000-4000-8000-${'000000000010'}`
const USER_ID = `00000000-0000-4000-8000-${'000000000001'}`
const DEPENDENCY_ID = `00000000-0000-4000-8000-${'000000000030'}`
const ITEM_ID = `00000000-0000-4000-8000-${'000000000040'}`
const INITIATED_AT = '2026-07-01T14:32:00.000Z'
const BILLING_WORKER_SYSTEM_NAME = 'billing-worker (production)'
const RETRY_SCHEDULED_AT = '2026-07-01T16:00:00.000Z'
const STILL_BROKEN_REASON = 'still broken'

describe('rotation response schemas', () => {
  it('accepts every reserved rotation status', () => {
    for (const status of [
      'in_progress',
      'completed',
      'abandoned',
      'stale_recovery',
      'break_glass_complete',
    ]) {
      expect(RotationStatusSchema.parse(status)).toBe(status)
    }
    expect(() => RotationStatusSchema.parse('bogus')).toThrow()
  })

  it('accepts every reserved checklist item status', () => {
    for (const status of ['unconfirmed', 'confirmed', 'failed', 'max_retries_exceeded']) {
      expect(RotationChecklistItemStatusSchema.parse(status)).toBe(status)
    }
    expect(() => RotationChecklistItemStatusSchema.parse('bogus')).toThrow()
  })

  it('parses a checklist item', () => {
    expect(
      RotationChecklistItemSchema.parse({
        id: ITEM_ID,
        dependencyId: DEPENDENCY_ID,
        systemName: BILLING_WORKER_SYSTEM_NAME,
        status: 'unconfirmed',
        confirmedBy: null,
        confirmedAt: null,
        retryCount: 0,
        retryScheduledAt: null,
        lastFailureReason: null,
        lastActedBy: null,
        lastActedAt: null,
      })
    ).toMatchObject({ systemName: BILLING_WORKER_SYSTEM_NAME, status: 'unconfirmed' })
  })

  it('parses a checklist item with Story 5.2 fields populated', () => {
    const parsed = RotationChecklistItemSchema.parse({
      id: ITEM_ID,
      dependencyId: DEPENDENCY_ID,
      systemName: BILLING_WORKER_SYSTEM_NAME,
      status: 'failed',
      confirmedBy: null,
      confirmedAt: null,
      retryCount: 2,
      retryScheduledAt: RETRY_SCHEDULED_AT,
      lastFailureReason: 'still using the old key',
      lastActedBy: USER_ID,
      lastActedAt: INITIATED_AT,
    })
    expect(parsed).toMatchObject({
      retryCount: 2,
      retryScheduledAt: RETRY_SCHEDULED_AT,
      lastFailureReason: 'still using the old key',
      lastActedBy: USER_ID,
      lastActedAt: INITIATED_AT,
    })
  })

  it('parses a rotation detail response with an empty checklist', () => {
    const parsed = RotationDetailSchema.parse({
      id: ROTATION_ID,
      credentialId: CREDENTIAL_ID,
      projectId: PROJECT_ID,
      status: 'in_progress',
      version: 1,
      initiatedBy: USER_ID,
      initiatedAt: INITIATED_AT,
      completedAt: null,
      notes: null,
      checklistItems: [],
    })
    expect(parsed).toMatchObject({ status: 'in_progress', checklistItems: [] })
  })

  it('parses a rotation detail response with sameValueAsPrevious set', () => {
    const parsed = RotationDetailSchema.parse({
      id: ROTATION_ID,
      credentialId: CREDENTIAL_ID,
      projectId: PROJECT_ID,
      status: 'in_progress',
      version: 1,
      initiatedBy: USER_ID,
      initiatedAt: INITIATED_AT,
      completedAt: null,
      notes: null,
      sameValueAsPrevious: true,
      checklistItems: [],
    })
    expect(parsed.sameValueAsPrevious).toBe(true)
  })

  it('rejects a non-positive rotation version', () => {
    expect(() =>
      RotationDetailSchema.parse({
        id: ROTATION_ID,
        credentialId: CREDENTIAL_ID,
        projectId: PROJECT_ID,
        status: 'in_progress',
        version: 0,
        initiatedBy: USER_ID,
        initiatedAt: INITIATED_AT,
        completedAt: null,
        notes: null,
        checklistItems: [],
      })
    ).toThrow()
  })

  it('parses a rotation summary list item', () => {
    const parsed = RotationSummarySchema.parse({
      id: ROTATION_ID,
      status: 'in_progress',
      initiatedBy: USER_ID,
      initiatedAt: INITIATED_AT,
      completedAt: null,
      itemCount: 2,
      confirmedCount: 0,
    })
    expect(parsed).toMatchObject({ itemCount: 2, confirmedCount: 0 })
    expect(parsed).not.toHaveProperty('notes')
  })
})

describe('ConfirmChecklistItemBodySchema', () => {
  it('accepts an empty body and an object with notes', () => {
    expect(ConfirmChecklistItemBodySchema.parse({})).toEqual({ notes: null })
    expect(ConfirmChecklistItemBodySchema.parse({ notes: 'looks good' })).toEqual({
      notes: 'looks good',
    })
  })

  it('trims and null-normalizes whitespace-only notes', () => {
    expect(ConfirmChecklistItemBodySchema.parse({ notes: '   ' })).toEqual({ notes: null })
  })

  it('rejects oversized notes and unknown keys', () => {
    expect(() => ConfirmChecklistItemBodySchema.parse({ notes: 'x'.repeat(1025) })).toThrow()
    expect(() => ConfirmChecklistItemBodySchema.parse({ notes: 'ok', extra: 1 })).toThrow()
  })
})

describe('FailChecklistItemBodySchema', () => {
  it('accepts a reason with an optional retryScheduledAt', () => {
    expect(FailChecklistItemBodySchema.parse({ reason: STILL_BROKEN_REASON })).toMatchObject({
      reason: STILL_BROKEN_REASON,
    })
    expect(
      FailChecklistItemBodySchema.parse({
        reason: STILL_BROKEN_REASON,
        retryScheduledAt: RETRY_SCHEDULED_AT,
      })
    ).toMatchObject({ retryScheduledAt: RETRY_SCHEDULED_AT })
  })

  it('rejects missing/empty/whitespace/oversized reason', () => {
    expect(() => FailChecklistItemBodySchema.parse({})).toThrow()
    expect(() => FailChecklistItemBodySchema.parse({ reason: '' })).toThrow()
    expect(() => FailChecklistItemBodySchema.parse({ reason: '   ' })).toThrow()
    expect(() => FailChecklistItemBodySchema.parse({ reason: 'x'.repeat(1025) })).toThrow()
  })

  it('rejects an invalid retryScheduledAt and unknown keys', () => {
    expect(() =>
      FailChecklistItemBodySchema.parse({ reason: 'ok', retryScheduledAt: 'not-a-date' })
    ).toThrow()
    expect(() => FailChecklistItemBodySchema.parse({ reason: 'ok', extra: true })).toThrow()
  })
})

describe('RetryChecklistItemBodySchema', () => {
  it('accepts only an empty object', () => {
    expect(RetryChecklistItemBodySchema.parse({})).toEqual({})
    expect(() => RetryChecklistItemBodySchema.parse({ anything: true })).toThrow()
  })
})

describe('CompleteRotationBodySchema', () => {
  it('accepts an empty body and acknowledgedNoDependencies', () => {
    expect(CompleteRotationBodySchema.parse({})).toEqual({})
    expect(CompleteRotationBodySchema.parse({ acknowledgedNoDependencies: true })).toEqual({
      acknowledgedNoDependencies: true,
    })
  })

  it('rejects a wrong-type acknowledgedNoDependencies and unknown keys', () => {
    expect(() => CompleteRotationBodySchema.parse({ acknowledgedNoDependencies: 'yes' })).toThrow()
    expect(() =>
      CompleteRotationBodySchema.parse({ acknowledgedNoDependencies: true, extra: 1 })
    ).toThrow()
  })
})

describe('UpcomingRotationsQuerySchema', () => {
  it('defaults horizon to 30d and accepts the other enum values', () => {
    expect(UpcomingRotationsQuerySchema.parse({})).toEqual({ horizon: '30d' })
    for (const horizon of ['7d', '30d', '90d']) {
      expect(UpcomingRotationsQuerySchema.parse({ horizon })).toEqual({ horizon })
    }
  })

  it('rejects an invalid horizon and unknown keys', () => {
    expect(() => UpcomingRotationsQuerySchema.parse({ horizon: '1d' })).toThrow()
    expect(() => UpcomingRotationsQuerySchema.parse({ horizon: '30d', extra: 1 })).toThrow()
  })
})
