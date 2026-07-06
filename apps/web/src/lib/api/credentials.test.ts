import { describe, expect, it, vi } from 'vitest'
import type { CredentialDetail, CredentialSummary, CredentialValue } from '@project-vault/shared'
import { ApiClientError } from './client.js'
import {
  confirmCredentialImport,
  createCredential,
  getCredential,
  listCredentialDependencies,
  listCredentialVersions,
  listCredentials,
  previewCredentialImport,
  revealCredentialValue,
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
  retentionCount: 5,
  currentVersionNumber: 1,
  createdBy: null,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
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

  it('listCredentialDependencies returns items and hasDependencies', async () => {
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
              createdBy: null,
              archivedAt: null,
              createdAt: '2026-06-01T00:00:00.000Z',
              updatedAt: '2026-06-01T00:00:00.000Z',
            },
          ],
          hasDependencies: true,
        },
      })
    )

    const result = await listCredentialDependencies(fetchFn, projectId, credentialId)

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/credentials/${credentialId}/dependencies`,
      expect.objectContaining({ credentials: 'include' })
    )
    expect(result.hasDependencies).toBe(true)
    expect(result.items[0]?.systemName).toBe('billing-worker (production)')
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
