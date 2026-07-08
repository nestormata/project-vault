// D3 — this app's first client-side "download the response body" flows (the audit-CSV export
// already sets `Content-Disposition` server-side, per D3, so it uses a plain `<a href>` and needs
// no helper here at all). These two utilities cover the two response shapes that don't come with
// a server-provided filename/header: the erasure compliance report (JSON) and the access-report
// CSV (a POST response body, so it can't be linked to directly).
function triggerBlobDownload(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/** AC-M2 — downloads the exact JSON payload already on screen, pretty-printed, no reformatting. */
export function triggerJsonDownload(filename: string, data: unknown): void {
  triggerBlobDownload(
    filename,
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  )
}

/** AC-G3 — downloads a pre-formatted string body (e.g. CSV text) with an explicit mime type. */
export function triggerTextDownload(filename: string, mimeType: string, text: string): void {
  triggerBlobDownload(filename, new Blob([text], { type: mimeType }))
}
