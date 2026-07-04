import { describe, expect, it } from 'vitest'
import {
  RotationChecklistItemSchema,
  RotationChecklistItemStatusSchema,
  RotationDetailSchema,
  RotationStatusSchema,
  RotationSummarySchema,
} from './rotations.js'

const ROTATION_ID = `00000000-0000-4000-8000-${'000000000099'}`
const CREDENTIAL_ID = `00000000-0000-4000-8000-${'000000000020'}`
const PROJECT_ID = `00000000-0000-4000-8000-${'000000000010'}`
const USER_ID = `00000000-0000-4000-8000-${'000000000001'}`
const DEPENDENCY_ID = `00000000-0000-4000-8000-${'000000000030'}`
const ITEM_ID = `00000000-0000-4000-8000-${'000000000040'}`
const INITIATED_AT = '2026-07-01T14:32:00.000Z'

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
        systemName: 'billing-worker (production)',
        status: 'unconfirmed',
        confirmedBy: null,
        confirmedAt: null,
      })
    ).toMatchObject({ systemName: 'billing-worker (production)', status: 'unconfirmed' })
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
