import { describe, expect, it, vi } from 'vitest'
import type { CredentialDetail, CredentialSummary, CredentialValue } from '@project-vault/shared'
import { ApiClientError } from './client.js'
import {
  addCredentialDependency,
  addCredentialVersion,
  archiveCredential,
  archiveCredentialDependency,
  confirmCredentialImport,
  createCredential,
  getCredential,
  listCredentialDependencies,
  listCredentialVersions,
  listCredentials,
  previewCredentialImport,
  revealCredentialValue,
  unarchiveCredential,
  updateCredentialDependencyLink,
  updateCredentialLifecycle,
} from './credentials.js'
import { jsonResponse } from '$lib/test/json-response.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const credentialId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const sampleSummary: CredentialSummary = {
  id: credentialId,
  projectId,
  name: 'Stripe Secret Key',
  description: null,
  tags: ['api'],
  status: 'expiring',
  expiresAt: '2026-07-15T00:00:00.000Z',
  rotationSchedule: null,
  currentVersionNumber: 1,
  hasDependencies: false,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  activeRotation: null,
  archivedAt: null,
}

const sampleDetail: CredentialDetail = {
  id: credentialId,
  projectId,
  orgId: '11111111-1111-4111-8111-111111111111',
  name: 'Stripe Secret Key',
  description: 'Prod API key',
  tags: ['api'],
  expiresAt: '2026-07-15T00:00:00.000Z',
  rotationSchedule: null,
  cacheable: true,
  retentionCount: 5,
  currentVersionNumber: 1,
  schemaVersion: 1,
  fields: [{ key: 'value', sensitive: true }],
  visibleFieldValues: {},
  createdBy: null,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  archivedAt: null,
}

describe('credential API helpers', () => {
  it('listCredentials builds query params and returns paginated data', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: { items: [sampleSummary], total: 1, page: 1, limit: 20, hasNext: false },
      })
    )

    const result = await listCredentials(fetchFn, projectId, {
      status: 'expiring',
      q: 'stripe',
      page: 2,
      limit: 10,
    })

    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0] ?? []
    expect(url).toContain(`/api/v1/projects/${projectId}/credentials?`)
    expect(url).toContain('status=expiring')
    expect(url).toContain('q=stripe')
    expect(url).toContain('page=2')
    expect(url).toContain('limit=10')
    expect(init).toMatchObject({ credentials: 'include' })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.name).toBe('Stripe Secret Key')
  })

  it('listCredentials({ includeArchived: true }) appends the query param', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: { items: [], total: 0, page: 1, limit: 20, hasNext: false },
      })
    )

    await listCredentials(fetchFn, projectId, { includeArchived: true })

    const [url] = fetchFn.mock.calls[0] ?? []
    expect(url).toContain('includeArchived=true')
  })

  it('listCredentials({ includeArchived: false }) omits the query param', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: { items: [], total: 0, page: 1, limit: 20, hasNext: false },
      })
    )

    await listCredentials(fetchFn, projectId)

    const [url] = fetchFn.mock.calls[0] ?? []
    expect(url).not.toContain('includeArchived')
  })

  // Story 28.5 AC2/AC3.
  it('archiveCredential posts to the archive URL and returns archive state', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          id: credentialId,
          name: 'Stripe Secret Key',
          archivedAt: '2026-07-01T00:00:00.000Z',
          isArchived: true,
        },
      })
    )

    const result = await archiveCredential(fetchFn, projectId, credentialId)

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/credentials/${credentialId}/archive`,
      expect.objectContaining({ method: 'POST' })
    )
    expect(result.isArchived).toBe(true)
  })

  it('unarchiveCredential posts to the unarchive URL and returns archive state', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: { id: credentialId, name: 'Stripe Secret Key', archivedAt: null, isArchived: false },
      })
    )

    const result = await unarchiveCredential(fetchFn, projectId, credentialId)

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/credentials/${credentialId}/unarchive`,
      expect.objectContaining({ method: 'POST' })
    )
    expect(result.isArchived).toBe(false)
  })

  it('archiveCredential surfaces 409 active_shares as a catchable ApiClientError carrying shareIds', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { error: 'active_shares', shareIds: ['dddddddd-dddd-4ddd-8ddd-dddddddddddd'] },
          { status: 409 }
        )
      )

    try {
      await archiveCredential(fetchFn, projectId, credentialId)
      throw new Error('expected archiveCredential to reject')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiClientError)
      expect((error as ApiClientError).status).toBe(409)
      expect((error as ApiClientError).code).toBe('active_shares')
    }
  })

  it('getCredential fetches metadata without value field', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: sampleDetail }))

    const result = await getCredential(fetchFn, projectId, credentialId)

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/credentials/${credentialId}`,
      expect.objectContaining({ credentials: 'include' })
    )
    expect(result.name).toBe('Stripe Secret Key')
    expect('value' in result).toBe(false)
  })

  it('revealCredentialValue fetches the value endpoint', async () => {
    const valuePayload: CredentialValue = {
      value: 'sk_live_test',
      versionNumber: 1,
      retrievedAt: '2026-06-29T12:00:00.000Z',
    }
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: valuePayload }))

    await expect(revealCredentialValue(fetchFn, projectId, credentialId)).resolves.toEqual(
      valuePayload
    )
    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/credentials/${credentialId}/value`,
      expect.objectContaining({ credentials: 'include' })
    )
  })

  it('listCredentialVersions returns version summaries', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          items: [
            {
              versionNumber: 1,
              createdBy: null,
              createdAt: '2026-06-01T00:00:00.000Z',
              isCurrent: true,
              purgedAt: null,
            },
          ],
        },
      })
    )

    const result = await listCredentialVersions(fetchFn, projectId, credentialId)
    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.isCurrent).toBe(true)
  })

  it('createCredential sends the expected body', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ data: { id: credentialId, name: 'New Key' } }, { status: 201 })
      )

    await createCredential(fetchFn, projectId, {
      name: 'New Key',
      value: 'secret',
      tags: ['prod'],
    })

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/credentials`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ name: 'New Key', value: 'secret', tags: ['prod'] }),
      })
    )
  })

  it('previewCredentialImport posts multipart form data without JSON content type', async () => {
    const file = new File(['KEY=value'], 'secrets.env', { type: 'text/plain' })
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          importId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          expiresAt: '2026-06-29T12:15:00.000Z',
          itemCount: 1,
          parsed: [
            {
              name: 'KEY',
              value: '[REDACTED]',
              conflictsWith: null,
              conflictName: null,
              suggestedAction: 'create_new',
            },
          ],
          warnings: [],
        },
      })
    )

    const result = await previewCredentialImport(fetchFn, projectId, file)

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/credentials/import`,
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: expect.any(FormData),
      })
    )
    const init = fetchFn.mock.calls[0]?.[1] as RequestInit
    expect(init.headers).toBeUndefined()
    expect(result.parsed[0]?.value).toBe('[REDACTED]')
  })

  it('confirmCredentialImport sends importId and defaultAction', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: { imported: 2, newVersions: 1, skipped: 0, results: [] },
      })
    )

    await confirmCredentialImport(fetchFn, projectId, {
      importId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      defaultAction: 'new_version',
    })

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/credentials/import/confirm`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          importId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          defaultAction: 'new_version',
        }),
      })
    )
  })

  it('listCredentialDependencies returns items, hasDependencies, hasStagedRotation, linkUrl, and checklistStatus', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          items: [
            {
              id: 'd1',
              credentialId,
              systemName: 'billing-worker (production)',
              systemType: 'service',
              notes: null,
              linkUrl: 'https://example.com/billing-worker',
              createdBy: null,
              archivedAt: null,
              createdAt: '2026-06-01T00:00:00.000Z',
              updatedAt: '2026-06-01T00:00:00.000Z',
              checklistStatus: {
                rotationId: 'r1',
                itemId: 'ci1',
                status: 'unconfirmed',
                confirmedBy: null,
                confirmedAt: null,
              },
            },
          ],
          hasDependencies: true,
          hasStagedRotation: true,
        },
      })
    )

    const result = await listCredentialDependencies(fetchFn, projectId, credentialId)

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/credentials/${credentialId}/dependencies`,
      expect.objectContaining({ credentials: 'include' })
    )
    expect(result.hasDependencies).toBe(true)
    expect(result.hasStagedRotation).toBe(true)
    expect(result.items[0]?.systemName).toBe('billing-worker (production)')
    expect(result.items[0]?.linkUrl).toBe('https://example.com/billing-worker')
    expect(result.items[0]?.checklistStatus).toMatchObject({ status: 'unconfirmed' })
  })

  // AC-L1: updateCredentialLifecycle always sends all three keys (full-overwrite from the UI's
  // perspective), and PATCHes the credential resource itself, not a sub-route.
  it('updateCredentialLifecycle PATCHes expiresAt/rotationSchedule/cacheable and returns the update', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          id: credentialId,
          expiresAt: '2026-12-01T00:00:00.000Z',
          rotationSchedule: '0 0 1 * *',
          cacheable: true,
          updatedAt: '2026-07-01T00:00:00.000Z',
        },
      })
    )

    const result = await updateCredentialLifecycle(fetchFn, projectId, credentialId, {
      expiresAt: '2026-12-01T00:00:00.000Z',
      rotationSchedule: '0 0 1 * *',
      cacheable: true,
    })

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/credentials/${credentialId}`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          expiresAt: '2026-12-01T00:00:00.000Z',
          rotationSchedule: '0 0 1 * *',
          cacheable: true,
        }),
      })
    )
    expect(result.expiresAt).toBe('2026-12-01T00:00:00.000Z')
  })

  // AC-L2: a rejected rotation schedule surfaces as a catchable ApiClientError carrying the
  // server's exact `invalid_cron` code/message pair.
  it('updateCredentialLifecycle surfaces a 422 invalid_cron error as a catchable ApiClientError', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { code: 'invalid_cron', message: 'Rotation schedule may run at most once per hour' },
          { status: 422 }
        )
      )

    await expect(
      updateCredentialLifecycle(fetchFn, projectId, credentialId, {
        expiresAt: null,
        rotationSchedule: '* * * * *',
        cacheable: true,
      })
    ).rejects.toMatchObject({
      status: 422,
      code: 'invalid_cron',
      message: 'Rotation schedule may run at most once per hour',
    } satisfies Partial<ApiClientError>)
  })

  // AC-D1: the pre-selected 'other' default is always sent explicitly, not omitted, so the UI's
  // displayed default always matches what's actually submitted.
  it('addCredentialDependency POSTs to .../dependencies and returns the created dependency', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          data: {
            id: 'd1',
            credentialId,
            systemName: 'billing-worker',
            systemType: 'other',
            notes: null,
            createdBy: null,
            archivedAt: null,
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
          },
        },
        { status: 201 }
      )
    )

    const result = await addCredentialDependency(fetchFn, projectId, credentialId, {
      systemName: 'billing-worker',
      systemType: 'other',
    })

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/credentials/${credentialId}/dependencies`,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ systemName: 'billing-worker', systemType: 'other' }),
      })
    )
    expect(result.systemType).toBe('other')
  })

  // AC-D3: the 200-cap must be catchable so the UI can render the exact server message inline.
  it('addCredentialDependency surfaces a 422 too_many_dependencies error as a catchable ApiClientError', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          code: 'too_many_dependencies',
          message: 'A credential may have at most 200 active dependencies',
        },
        { status: 422 }
      )
    )

    await expect(
      addCredentialDependency(fetchFn, projectId, credentialId, {
        systemName: 'one-too-many',
        systemType: 'other',
      })
    ).rejects.toMatchObject({
      status: 422,
      code: 'too_many_dependencies',
    } satisfies Partial<ApiClientError>)
  })

  // AC-D2: archiving calls the DELETE sub-route with the dependency id.
  it('archiveCredentialDependency DELETEs .../dependencies/:dependencyId', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: { id: 'd1', credentialId, archivedAt: '2026-07-01T00:00:00.000Z' },
      })
    )

    const result = await archiveCredentialDependency(fetchFn, projectId, credentialId, 'd1')

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/credentials/${credentialId}/dependencies/d1`,
      expect.objectContaining({ method: 'DELETE' })
    )
    expect(result.archivedAt).toBe('2026-07-01T00:00:00.000Z')
  })

  // AC-3: updateCredentialDependencyLink PATCHes .../dependencies/:dependencyId with linkUrl,
  // and can send an explicit `null` to clear it.
  it('updateCredentialDependencyLink PATCHes .../dependencies/:dependencyId and returns the update', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          id: 'd1',
          linkUrl: 'https://example.com/new',
          updatedAt: '2026-07-01T00:00:00.000Z',
        },
      })
    )

    const result = await updateCredentialDependencyLink(
      fetchFn,
      projectId,
      credentialId,
      'd1',
      'https://example.com/new'
    )

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/credentials/${credentialId}/dependencies/d1`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ linkUrl: 'https://example.com/new' }),
      })
    )
    expect(result.linkUrl).toBe('https://example.com/new')
  })

  it('updateCredentialDependencyLink can clear linkUrl by sending null', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: { id: 'd1', linkUrl: null, updatedAt: '2026-07-01T00:00:00.000Z' },
      })
    )

    const result = await updateCredentialDependencyLink(
      fetchFn,
      projectId,
      credentialId,
      'd1',
      null
    )

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/credentials/${credentialId}/dependencies/d1`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ linkUrl: null }),
      })
    )
    expect(result.linkUrl).toBeNull()
  })

  // AC-V1: addCredentialVersion POSTs the new value and returns the confirmed version number
  // (never echoing the submitted value back).
  it('addCredentialVersion POSTs to .../versions and returns the new version number', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          data: { credentialId, versionNumber: 2, createdAt: '2026-07-01T00:00:00.000Z' },
        },
        { status: 201 }
      )
    )

    const result = await addCredentialVersion(fetchFn, projectId, credentialId, {
      value: 'sk_live_new',
    })

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/credentials/${credentialId}/versions`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ value: 'sk_live_new' }) })
    )
    expect(result.versionNumber).toBe(2)
  })

  // AC-V2: a concurrent-insert race must be catchable so the UI can render an actionable message.
  it('addCredentialVersion surfaces a 409 version_conflict error as a catchable ApiClientError', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ code: 'version_conflict', message: 'Version conflict' }, { status: 409 })
      )

    await expect(
      addCredentialVersion(fetchFn, projectId, credentialId, { value: 'sk_live_new' })
    ).rejects.toMatchObject({
      status: 409,
      code: 'version_conflict',
    } satisfies Partial<ApiClientError>)
  })

  it('surfaces API errors from reveal', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ code: 'forbidden', message: 'Insufficient role' }, { status: 403 })
      )

    await expect(revealCredentialValue(fetchFn, projectId, credentialId)).rejects.toMatchObject({
      status: 403,
    } satisfies Partial<ApiClientError>)
  })
})
