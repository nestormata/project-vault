import { describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '$lib/test/json-response.js'
import {
  disableStatusPage,
  enableStatusPage,
  getStatusPageConfig,
  regenerateStatusPageToken,
  updateStatusPageServices,
} from './status-page.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const statusPageUrl = `/api/v1/projects/${projectId}/status-page`

describe('status-page API wrappers', () => {
  it('loads the current status-page configuration', async () => {
    const config = { enabled: true, token: null, services: [] }
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: config }))

    await expect(getStatusPageConfig(fetchFn, projectId)).resolves.toEqual(config)
    expect(fetchFn).toHaveBeenCalledWith(
      statusPageUrl,
      expect.objectContaining({ credentials: 'include' })
    )
  })

  it('uses the documented methods, paths, and payloads for every mutation', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ data: { token: 'enabled-token' } }))
      .mockResolvedValueOnce(jsonResponse({ data: { token: 'regenerated-token' } }))
      .mockResolvedValueOnce(jsonResponse({ data: { services: [] } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))

    await expect(enableStatusPage(fetchFn, projectId)).resolves.toEqual({
      token: 'enabled-token',
    })
    await expect(regenerateStatusPageToken(fetchFn, projectId)).resolves.toEqual({
      token: 'regenerated-token',
    })
    await expect(
      updateStatusPageServices(fetchFn, projectId, {
        services: [{ serviceId: 'endpoint-1', displayName: 'Public API' }],
      })
    ).resolves.toEqual({ services: [] })
    await expect(disableStatusPage(fetchFn, projectId)).resolves.toBeUndefined()

    expect(fetchFn).toHaveBeenNthCalledWith(
      1,
      statusPageUrl,
      expect.objectContaining({ method: 'POST', body: '{}' })
    )
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      `${statusPageUrl}/regenerate`,
      expect.objectContaining({ method: 'POST' })
    )
    expect(fetchFn).toHaveBeenNthCalledWith(
      3,
      statusPageUrl,
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          services: [{ serviceId: 'endpoint-1', displayName: 'Public API' }],
        }),
      })
    )
    expect(fetchFn).toHaveBeenNthCalledWith(
      4,
      statusPageUrl,
      expect.objectContaining({ method: 'DELETE' })
    )
  })
})
