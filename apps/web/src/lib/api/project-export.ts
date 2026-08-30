import { ApiClientError, parseApiEnvelope } from './client.js'

export type ExportProjectResult = { blob: Blob; filename: string; exportKey: string }

const DEFAULT_EXPORT_FILENAME = 'project-export.pvexport'

/** Story 28.9 AC-1 — the export endpoint returns the encrypted file as the response body and
 *  the one-time key in the `X-Export-Key` response header, both in the same response. This
 *  bypasses `apiFetch()` (which assumes a JSON envelope) since the 200 body here is raw bytes. */
export async function exportProject(
  fetchFn: typeof fetch,
  projectId: string
): Promise<ExportProjectResult> {
  const response = await fetchFn(`/api/v1/projects/${projectId}/export`, {
    method: 'POST',
    credentials: 'include',
  })
  if (!response.ok) {
    let body: Record<string, unknown> | null = null
    try {
      body = (await response.json()) as Record<string, unknown>
    } catch {
      // Error responses on this route are always JSON (only the 200 body is binary) — an empty/
      // unparsable body here just means we fall back to a generic message below.
    }
    throw new ApiClientError(
      response.status,
      body,
      (body?.['message'] as string | undefined) ?? 'Export failed'
    )
  }
  const exportKey = response.headers.get('x-export-key') ?? ''
  const disposition = response.headers.get('content-disposition') ?? ''
  const match = /filename="([^"]+)"/.exec(disposition)
  const filename = match?.[1] ?? DEFAULT_EXPORT_FILENAME
  const blob = await response.blob()
  return { blob, filename, exportKey }
}

/** Triggers a real browser file download for a Blob obtained from `exportProject()` — no
 *  server-side storage of the export file exists (D3), so this is the only place the bytes ever
 *  land outside the response itself. */
export function downloadExportBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export type ImportProjectResult = {
  projectId: string
  name: string
  importedCounts: Record<string, number>
}

/** Story 28.9 AC-3 — multipart upload of the `.pvexport` file plus its matching export key,
 *  both required in the same request (D3 — no "stage the file, supply the key later" flow). */
export async function importProject(
  fetchFn: typeof fetch,
  file: File,
  exportKey: string,
  projectName?: string
): Promise<ImportProjectResult> {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('exportKey', exportKey)
  if (projectName) formData.append('projectName', projectName)

  const response = await fetchFn('/api/v1/projects/import', {
    method: 'POST',
    credentials: 'include',
    body: formData,
  })
  return parseApiEnvelope<ImportProjectResult>(response)
}
