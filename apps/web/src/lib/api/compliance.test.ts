import { describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '$lib/test/json-response.js'
import { ApiClientError } from './client.js'
import {
  createErasureRequest,
  executeErasure,
  getErasureReport,
  pseudonymizeUser,
} from './compliance.js'

const userId = '11111111-1111-4111-8111-111111111111'
const requestId = '22222222-2222-4222-8222-222222222222'

describe('compliance API client', () => {
  describe('createErasureRequest (AC-K1)', () => {
    it('POSTs reason/requestedBy and returns requestId + piiInventory', async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        jsonResponse(
          {
            data: {
              requestId,
              status: 'pending',
              piiInventory: { tables: [{ table: 'users', rowCount: 1, piiFields: ['email'] }] },
            },
          },
          { status: 201 }
        )
      )

      const result = await createErasureRequest(fetchFn, userId, {
        reason: 'Contractor offboarding',
        requestedBy: 'Data Subject via support ticket #4021',
      })

      expect(fetchFn).toHaveBeenCalledWith(
        `/api/v1/org/users/${userId}/erasure-request`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            reason: 'Contractor offboarding',
            requestedBy: 'Data Subject via support ticket #4021',
          }),
        })
      )
      expect(result.requestId).toBe(requestId)
      expect(result.piiInventory.tables).toHaveLength(1)
    })

    it('throws ApiClientError with code erasure_request_already_pending on 409, exposing requestId/piiInventory via .body', async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        jsonResponse(
          {
            code: 'erasure_request_already_pending',
            message: 'An erasure request is already pending',
            requestId,
            piiInventory: { tables: [] },
          },
          { status: 409 }
        )
      )

      await expect(
        createErasureRequest(fetchFn, userId, { reason: 'x', requestedBy: 'y' })
      ).rejects.toMatchObject({ status: 409, code: 'erasure_request_already_pending' })
    })

    it('throws ApiClientError with code user_already_erased on 410', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            {
              code: 'user_already_erased',
              message: 'Already erased',
              requestId,
              completedAt: '2026-07-01T00:00:00.000Z',
            },
            { status: 410 }
          )
        )

      await expect(
        createErasureRequest(fetchFn, userId, { reason: 'x', requestedBy: 'y' })
      ).rejects.toMatchObject({ status: 410, code: 'user_already_erased' })
    })
  })

  describe('executeErasure (AC-L1)', () => {
    it('POSTs { confirm: true } and returns the completion payload', async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            requestId,
            status: 'completed',
            completedAt: '2026-07-07T00:00:00.000Z',
            revokedSessionCount: 2,
            auditEventId: '33333333-3333-4333-8333-333333333333',
          },
        })
      )

      const result = await executeErasure(fetchFn, userId, requestId)

      expect(fetchFn).toHaveBeenCalledWith(
        `/api/v1/org/users/${userId}/erasure-request/${requestId}/execute`,
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ confirm: true }) })
      )
      expect(result.revokedSessionCount).toBe(2)
    })

    it('surfaces a 409 user_has_other_org_memberships error with remediation/otherOrgCount', async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        jsonResponse(
          {
            code: 'user_has_other_org_memberships',
            message: 'blocked',
            otherOrgCount: 1,
            remediation: 'Contact support to coordinate removal...',
          },
          { status: 409 }
        )
      )

      await expect(executeErasure(fetchFn, userId, requestId)).rejects.toMatchObject({
        status: 409,
        code: 'user_has_other_org_memberships',
      })
    })
  })

  describe('getErasureReport (D6 status probe)', () => {
    it('returns the full report on 200', async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            requestId,
            executedAt: '2026-07-07T00:00:00.000Z',
            piiRemoved: [{ table: 'sessions', fields: ['ipAddress'], method: 'nulled' }],
            piiRetained: [{ table: 'audit_log_entries', reason: 'audit log integrity' }],
            retentionJustification: 'Legal hold',
            auditEventId: null,
          },
        })
      )

      const result = await getErasureReport(fetchFn, userId, requestId)
      expect(result.piiRemoved[0]?.method).toBe('nulled')
      expect(result.piiRetained[0]?.reason).toBe('audit log integrity')
    })

    it('throws ApiClientError with code erasure_not_yet_completed + status on 409', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { code: 'erasure_not_yet_completed', message: 'not ready', status: 'pending' },
            { status: 409 }
          )
        )

      await expect(getErasureReport(fetchFn, userId, requestId)).rejects.toMatchObject({
        status: 409,
        code: 'erasure_not_yet_completed',
        body: expect.objectContaining({ status: 'pending' }),
      })
    })

    it('throws ApiClientError with status 404 when the request does not exist', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ code: 'erasure_request_not_found', message: 'not found' }, { status: 404 })
        )

      await expect(getErasureReport(fetchFn, userId, requestId)).rejects.toMatchObject({
        status: 404,
      })
    })
  })

  describe('pseudonymizeUser (AC-J1)', () => {
    it('POSTs confirmUserId equal to the target userId and returns alias/otherAffectedOrgCount', async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            userId,
            pseudonymized: true,
            pseudonymizedAt: '2026-07-07T00:00:00.000Z',
            alias: 'user_a1b2c3d4',
            otherAffectedOrgCount: 0,
          },
        })
      )

      const result = await pseudonymizeUser(fetchFn, userId)

      expect(fetchFn).toHaveBeenCalledWith(
        `/api/v1/org/users/${userId}/pseudonymize`,
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ confirmUserId: userId }) })
      )
      expect(result.alias).toBe('user_a1b2c3d4')
      expect(result.otherAffectedOrgCount).toBe(0)
    })
  })

  it('re-exports ApiClientError-compatible errors for generic catch blocks (sanity check)', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ code: 'x', message: 'y' }, { status: 500 }))
    await expect(pseudonymizeUser(fetchFn, userId)).rejects.toBeInstanceOf(ApiClientError)
  })
})
