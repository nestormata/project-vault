import { describe, expect, it } from 'vitest'
import { credentialVersions, rotationChecklistItems, rotations } from './index.js'
import { EXCLUDED_TABLES } from '../check-rls-coverage.js'

describe('rotations schema', () => {
  it('exposes org-scoped rotations columns', () => {
    expect(rotations.id).toBeDefined()
    expect(rotations.orgId).toBeDefined()
    expect(rotations.projectId).toBeDefined()
    expect(rotations.credentialId).toBeDefined()
    expect(rotations.newVersionId).toBeDefined()
    expect(rotations.previousVersionId).toBeDefined()
    expect(rotations.status).toBeDefined()
    expect(rotations.version).toBeDefined()
    expect(rotations.initiatedBy).toBeDefined()
    expect(rotations.initiatedAt).toBeDefined()
    expect(rotations.completedAt).toBeDefined()
    expect(rotations.notes).toBeDefined()
    expect(rotations.createdAt).toBeDefined()
    expect(rotations.updatedAt).toBeDefined()
  })

  it('exposes org-scoped rotation_checklist_items columns', () => {
    expect(rotationChecklistItems.id).toBeDefined()
    expect(rotationChecklistItems.orgId).toBeDefined()
    expect(rotationChecklistItems.rotationId).toBeDefined()
    expect(rotationChecklistItems.dependencyId).toBeDefined()
    expect(rotationChecklistItems.systemName).toBeDefined()
    expect(rotationChecklistItems.status).toBeDefined()
    expect(rotationChecklistItems.confirmedBy).toBeDefined()
    expect(rotationChecklistItems.confirmedAt).toBeDefined()
    expect(rotationChecklistItems.notes).toBeDefined()
    expect(rotationChecklistItems.createdAt).toBeDefined()
    expect(rotationChecklistItems.updatedAt).toBeDefined()
  })

  it('exposes Story 5.2 checklist-item state columns (retry/failure/last-acted)', () => {
    expect(rotationChecklistItems.retryCount).toBeDefined()
    expect(rotationChecklistItems.retryScheduledAt).toBeDefined()
    expect(rotationChecklistItems.lastFailureReason).toBeDefined()
    expect(rotationChecklistItems.lastActedBy).toBeDefined()
    expect(rotationChecklistItems.lastActedAt).toBeDefined()
  })

  it('keeps rotation tables subject to RLS coverage', () => {
    expect(EXCLUDED_TABLES.has('rotations')).toBe(false)
    expect(EXCLUDED_TABLES.has('rotation_checklist_items')).toBe(false)
  })

  it('exposes Story 5.3 credential_versions break-glass/abandonment columns', () => {
    expect(credentialVersions.breakGlassOverlapExpiresAt).toBeDefined()
    expect(credentialVersions.abandonedAt).toBeDefined()
  })
})
