import { describe, expect, it, vi } from 'vitest'
import type { RotationDetail, RotationSummary } from '@project-vault/shared'
import { ApiClientError } from './client.js'
import {
  abandonRotation,
  breakGlassRotation,
  completeRotation,
  confirmChecklistItem,
  failChecklistItem,
  getRotation,
  initiateRotation,
  listRotations,
  listUpcomingRotations,
  resumeRotation,
  retryChecklistItem,
} from './rotations.js'
import { jsonResponse } from '$lib/test/json-response.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const credentialId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const rotationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const itemId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

const sampleDetail: RotationDetail = {
  id: rotationId,
  credentialId,
  projectId,
  status: 'in_progress',
  version: 1,
  initiatedBy: null,
  initiatedAt: '2026-07-01T14:10:00.000Z',
  completedAt: null,
  notes: null,
  checklistItems: [],
}

const sampleSummary: RotationSummary = {
  id: rotationId,
  status: 'completed',
  initiatedBy: null,
  initiatedAt: '2026-06-01T09:00:00.000Z',
  completedAt: '2026-06-01T09:45:00.000Z',
  itemCount: 3,
  confirmedCount: 3,
}

describe('rotation API helpers', () => {
  it('initiateRotation posts newValue/notes and returns the created rotation', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: sampleDetail }, { status: 201 }))

    const result = await initiateRotation(fetchFn, projectId, credentialId, {
      newValue: 'sk_live_new',
      notes: 'Rotating after review',
    })

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/credentials/${credentialId}/rotations`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ newValue: 'sk_live_new', notes: 'Rotating after review' }),
        credentials: 'include',
      })
    )
    expect(result.id).toBe(rotationId)
  })

  it('initiateRotation surfaces 409 rotation_in_progress with rotationId', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          {
            code: 'rotation_in_progress',
            message: 'A rotation is already in progress',
            rotationId,
          },
          { status: 409 }
        )
      )

    await expect(
      initiateRotation(fetchFn, projectId, credentialId, { newValue: 'x' })
    ).rejects.toMatchObject({
      status: 409,
      code: 'rotation_in_progress',
      details: undefined,
    } satisfies Partial<ApiClientError>)
  })

  it('getRotation fetches a single rotation by id', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: sampleDetail }))

    const result = await getRotation(fetchFn, projectId, credentialId, rotationId)

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/credentials/${credentialId}/rotations/${rotationId}`,
      expect.objectContaining({ credentials: 'include' })
    )
    expect(result.status).toBe('in_progress')
  })

  it('getRotation surfaces 404 rotation_not_found', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ code: 'rotation_not_found', message: 'Rotation not found' }, { status: 404 })
      )

    await expect(getRotation(fetchFn, projectId, credentialId, rotationId)).rejects.toMatchObject({
      status: 404,
      code: 'rotation_not_found',
    })
  })

  it('listRotations builds the limit query and returns paginated history', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: { items: [sampleSummary], page: 1, limit: 10, total: 1, hasMore: false },
      })
    )

    const result = await listRotations(fetchFn, projectId, credentialId, { limit: 10 })

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/credentials/${credentialId}/rotations?limit=10`,
      expect.objectContaining({ credentials: 'include' })
    )
    expect(result.items).toHaveLength(1)
  })

  it('listRotations supports page param', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: { items: [], page: 2, limit: 10, total: 0, hasMore: false },
      })
    )

    await listRotations(fetchFn, projectId, credentialId, { page: 2, limit: 10 })

    const [url] = fetchFn.mock.calls[0] ?? []
    expect(url).toContain('page=2')
    expect(url).toContain('limit=10')
  })

  it('confirmChecklistItem posts optional notes and returns the updated item', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          item: {
            id: itemId,
            dependencyId: null,
            systemName: 'GitHub Actions',
            status: 'confirmed',
            confirmedBy: null,
            confirmedAt: '2026-07-01T15:00:00.000Z',
            retryCount: 0,
            retryScheduledAt: null,
            lastFailureReason: null,
            lastActedBy: null,
            lastActedAt: null,
          },
          rotationVersion: 2,
        },
      })
    )

    const result = await confirmChecklistItem(
      fetchFn,
      projectId,
      credentialId,
      rotationId,
      itemId,
      {
        notes: 'verified',
      }
    )

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/credentials/${credentialId}/rotations/${rotationId}/checklist/${itemId}/confirm`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ notes: 'verified' }),
      })
    )
    expect(result.item.status).toBe('confirmed')
  })

  it('confirmChecklistItem surfaces 409 already_confirmed with confirmedBy/confirmedAt', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          code: 'already_confirmed',
          message: 'Already confirmed',
          confirmedBy: 'user-1',
          confirmedAt: '2026-07-01T15:00:00.000Z',
        },
        { status: 409 }
      )
    )

    await expect(
      confirmChecklistItem(fetchFn, projectId, credentialId, rotationId, itemId, {})
    ).rejects.toMatchObject({ status: 409, code: 'already_confirmed' })
  })

  it('failChecklistItem posts reason and retryScheduledAt', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          item: {
            id: itemId,
            dependencyId: null,
            systemName: 'GitHub Actions',
            status: 'failed',
            confirmedBy: null,
            confirmedAt: null,
            retryCount: 0,
            retryScheduledAt: null,
            lastFailureReason: 'still on old key',
            lastActedBy: null,
            lastActedAt: null,
          },
          rotationVersion: 2,
        },
      })
    )

    await failChecklistItem(fetchFn, projectId, credentialId, rotationId, itemId, {
      reason: 'still on old key',
      retryScheduledAt: null,
    })

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/credentials/${credentialId}/rotations/${rotationId}/checklist/${itemId}/fail`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ reason: 'still on old key', retryScheduledAt: null }),
      })
    )
  })

  it('retryChecklistItem posts an empty body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          item: {
            id: itemId,
            dependencyId: null,
            systemName: 'GitHub Actions',
            status: 'unconfirmed',
            confirmedBy: null,
            confirmedAt: null,
            retryCount: 1,
            retryScheduledAt: null,
            lastFailureReason: null,
            lastActedBy: null,
            lastActedAt: null,
          },
          rotationVersion: 3,
        },
      })
    )

    await retryChecklistItem(fetchFn, projectId, credentialId, rotationId, itemId)

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/credentials/${credentialId}/rotations/${rotationId}/checklist/${itemId}/retry`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({}) })
    )
  })

  it('retryChecklistItem surfaces 422 max_retries_exceeded with retryCount/maxRetries', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          code: 'max_retries_exceeded',
          message: 'Maximum retry attempts (3) reached',
          retryCount: 3,
          maxRetries: 3,
        },
        { status: 422 }
      )
    )

    await expect(
      retryChecklistItem(fetchFn, projectId, credentialId, rotationId, itemId)
    ).rejects.toMatchObject({
      status: 422,
      code: 'max_retries_exceeded',
      details: undefined,
    })
  })

  it('completeRotation posts acknowledgedNoDependencies when provided', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({
          data: { ...sampleDetail, status: 'completed', completedAt: '2026-07-02T00:00:00.000Z' },
        })
      )

    await completeRotation(fetchFn, projectId, credentialId, rotationId, {
      acknowledgedNoDependencies: true,
    })

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/credentials/${credentialId}/rotations/${rotationId}/complete`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ acknowledgedNoDependencies: true }),
      })
    )
  })

  it('completeRotation surfaces 422 checklist_incomplete with pendingItems', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          code: 'checklist_incomplete',
          message: '1 of 2 checklist items are not yet confirmed.',
          pendingItems: [{ id: itemId, systemName: 'GitHub Actions', status: 'unconfirmed' }],
        },
        { status: 422 }
      )
    )

    await expect(
      completeRotation(fetchFn, projectId, credentialId, rotationId, {})
    ).rejects.toMatchObject({ status: 422, code: 'checklist_incomplete' })
  })

  it('breakGlassRotation posts newValue/reason and returns the created rotation', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          data: {
            ...sampleDetail,
            status: 'break_glass_complete',
            checklistItems: [],
            previousVersionOverlap: {
              versionNumber: 1,
              breakGlassOverlapExpiresAt: '2026-07-01T16:00:00.000Z',
            },
          },
        },
        { status: 201 }
      )
    )

    const result = await breakGlassRotation(fetchFn, projectId, credentialId, {
      newValue: 'sk_live_emergency',
      reason: 'Key leaked in logs',
    })

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/credentials/${credentialId}/rotations/break-glass`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ newValue: 'sk_live_emergency', reason: 'Key leaked in logs' }),
      })
    )
    expect(result.checklistItems).toEqual([])
    expect(result.previousVersionOverlap?.breakGlassOverlapExpiresAt).toBe(
      '2026-07-01T16:00:00.000Z'
    )
  })

  it('breakGlassRotation surfaces 409 rotation_lock_contention', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          code: 'rotation_lock_contention',
          message: 'Another rotation operation is in progress',
          credentialId,
        },
        { status: 409 }
      )
    )

    await expect(
      breakGlassRotation(fetchFn, projectId, credentialId, { newValue: 'x', reason: 'y' })
    ).rejects.toMatchObject({ status: 409, code: 'rotation_lock_contention' })
  })

  it('resumeRotation posts an empty body', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: { ...sampleDetail, status: 'in_progress' } }))

    await resumeRotation(fetchFn, projectId, credentialId, rotationId)

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/credentials/${credentialId}/rotations/${rotationId}/resume`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({}) })
    )
  })

  it('resumeRotation surfaces 422 rotation_not_stale', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          code: 'rotation_not_stale',
          message: 'This rotation is not awaiting stale-recovery resolution.',
          status: 'in_progress',
        },
        { status: 422 }
      )
    )

    await expect(
      resumeRotation(fetchFn, projectId, credentialId, rotationId)
    ).rejects.toMatchObject({ status: 422, code: 'rotation_not_stale' })
  })

  it('abandonRotation posts an empty body', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: { ...sampleDetail, status: 'abandoned' } }))

    await abandonRotation(fetchFn, projectId, credentialId, rotationId)

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/credentials/${credentialId}/rotations/${rotationId}/abandon`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({}) })
    )
  })

  it('listUpcomingRotations builds horizon query and returns items', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          items: [
            {
              credentialId,
              credentialName: 'sk_stripe_live',
              scheduledAt: '2026-06-28T00:00:00.000Z',
              status: 'overdue',
            },
          ],
        },
      })
    )

    const result = await listUpcomingRotations(fetchFn, projectId, { horizon: '30d' })

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/rotations/upcoming?horizon=30d`,
      expect.objectContaining({ credentials: 'include' })
    )
    expect(result.items[0]?.status).toBe('overdue')
  })

  it('listUpcomingRotations omits query when no horizon is given', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: { items: [] } }))

    await listUpcomingRotations(fetchFn, projectId)

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/rotations/upcoming`,
      expect.objectContaining({ credentials: 'include' })
    )
  })

  it('surfaces a sane ApiClientError when a 404 has no parseable JSON body', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        new Response('not json', { status: 404, headers: { 'Content-Type': 'text/plain' } })
      )

    await expect(getRotation(fetchFn, projectId, credentialId, rotationId)).rejects.toBeInstanceOf(
      ApiClientError
    )
  })

  it('surfaces 503 sealed-vault responses as ApiClientError', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ status: 'sealed' }, { status: 503 }))

    await expect(
      initiateRotation(fetchFn, projectId, credentialId, { newValue: 'x' })
    ).rejects.toMatchObject({ status: 503 })
  })
})
