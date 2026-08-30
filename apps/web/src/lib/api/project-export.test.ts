import { describe, expect, it, vi } from 'vitest'
import { downloadExportBlob, exportProject, importProject } from './project-export.js'
import { ApiClientError } from './client.js'
import { jsonResponse } from '$lib/test/json-response.js'
import * as downloadModule from '../download.js'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('project-export API wrapper (Story 28.9)', () => {
  it('exportProject POSTs to the export endpoint and returns the blob/filename/key from the response', async () => {
    const response = new Response('encrypted-bytes', {
      status: 200,
      headers: {
        'x-export-key': 'the-raw-export-key',
        'content-disposition': 'attachment; filename="my-project-20260830.pvexport"',
      },
    })
    const fetchFn = vi.fn().mockResolvedValue(response)

    const result = await exportProject(fetchFn, projectId)

    expect(fetchFn).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/export`,
      expect.objectContaining({ method: 'POST', credentials: 'include' })
    )
    expect(result.exportKey).toBe('the-raw-export-key')
    expect(result.filename).toBe('my-project-20260830.pvexport')
    expect(await result.blob.text()).toBe('encrypted-bytes')
  })

  it('exportProject falls back to a default filename when Content-Disposition is missing', async () => {
    const response = new Response('x', { status: 200 })
    const fetchFn = vi.fn().mockResolvedValue(response)

    const result = await exportProject(fetchFn, projectId)

    expect(result.filename).toBe('project-export.pvexport')
    expect(result.exportKey).toBe('')
  })

  it('exportProject throws ApiClientError with the server message on a non-OK response', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: 'insufficient_role' }, { status: 403 }))

    await expect(exportProject(fetchFn, projectId)).rejects.toMatchObject({
      status: 403,
      message: 'insufficient_role',
    })
  })

  it('exportProject falls back to a generic message when the error body is not JSON', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('not json', { status: 500 }))

    await expect(exportProject(fetchFn, projectId)).rejects.toMatchObject({
      status: 500,
      message: 'Export failed',
    })
  })

  it('downloadExportBlob delegates to the shared triggerBlobDownload helper', () => {
    const spy = vi.spyOn(downloadModule, 'triggerBlobDownload').mockImplementation(() => {})
    const blob = new Blob(['x'])

    downloadExportBlob(blob, 'export.pvexport')

    expect(spy).toHaveBeenCalledWith('export.pvexport', blob)
    spy.mockRestore()
  })

  it('importProject POSTs a multipart form with file, exportKey, and optional projectName', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: { projectId: 'new-project-id', name: 'Imported', importedCounts: { credentials: 1 } },
      })
    )
    const file = new File(['bytes'], 'export.pvexport')

    const result = await importProject(fetchFn, file, 'the-export-key', 'Custom Name')

    const [url, init] = fetchFn.mock.calls[0] ?? []
    expect(url).toBe('/api/v1/projects/import')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('include')
    const body = init.body as FormData
    expect(body.get('file')).toBe(file)
    expect(body.get('exportKey')).toBe('the-export-key')
    expect(body.get('projectName')).toBe('Custom Name')
    expect(result).toEqual({
      projectId: 'new-project-id',
      name: 'Imported',
      importedCounts: { credentials: 1 },
    })
  })

  it('importProject omits projectName from the form when not provided', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: { projectId: 'p1', name: 'X', importedCounts: {} } }))
    const file = new File(['bytes'], 'export.pvexport')

    await importProject(fetchFn, file, 'the-export-key')

    const [, init] = fetchFn.mock.calls[0] ?? []
    const body = init.body as FormData
    expect(body.has('projectName')).toBe(false)
  })

  it('importProject surfaces a decrypt-failure error via ApiClientError', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ code: 'import_decrypt_failed', message: 'bad key' }, { status: 401 })
      )
    const file = new File(['bytes'], 'export.pvexport')

    const error = await importProject(fetchFn, file, 'wrong-key').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(ApiClientError)
    expect((error as ApiClientError).status).toBe(401)
  })
})
