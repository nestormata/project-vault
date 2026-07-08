import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { triggerJsonDownload, triggerTextDownload } from './download.js'

// D3 — the audit-CSV export (plain <a href>) is out of scope here (no JS involved at all, per
// D3's own decision); this file covers only the two JS-driven download mechanisms: the erasure
// compliance report (JSON, AC-M2) and the access-report CSV (text, AC-G3).
describe('download utilities (D3)', () => {
  let createObjectURLSpy: ReturnType<typeof vi.fn>
  let revokeObjectURLSpy: ReturnType<typeof vi.fn>
  let clickSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    createObjectURLSpy = vi.fn().mockReturnValue('blob:mock-url')
    revokeObjectURLSpy = vi.fn()
    // jsdom does not implement these — stub them for every test in this file.
    URL.createObjectURL = createObjectURLSpy as unknown as typeof URL.createObjectURL
    URL.revokeObjectURL = revokeObjectURLSpy as unknown as typeof URL.revokeObjectURL
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('triggerJsonDownload builds a pretty-printed JSON blob and clicks a temporary anchor with the given filename', async () => {
    triggerJsonDownload('erasure-report-abc123.json', { requestId: 'abc123', piiRemoved: [] })

    expect(createObjectURLSpy).toHaveBeenCalledTimes(1)
    const blob = createObjectURLSpy.mock.calls[0]?.[0] as Blob
    expect(blob.type).toBe('application/json')
    expect(await blob.text()).toBe(JSON.stringify({ requestId: 'abc123', piiRemoved: [] }, null, 2))
    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:mock-url')
  })

  it('triggerTextDownload builds a blob with the given mime type and exact text, no JSON re-serialization', async () => {
    const csv = 'displayName,orgRole\nDana Smith,owner\n'
    triggerTextDownload('access-report-2026-03-01.csv', 'text/csv', csv)

    expect(createObjectURLSpy).toHaveBeenCalledTimes(1)
    const blob = createObjectURLSpy.mock.calls[0]?.[0] as Blob
    expect(blob.type).toBe('text/csv')
    expect(await blob.text()).toBe(csv)
    expect(clickSpy).toHaveBeenCalledTimes(1)
  })

  it('sets the anchor download attribute to the given filename', () => {
    let capturedAnchor: HTMLAnchorElement | null = null
    const appendSpy = vi.spyOn(document.body, 'appendChild').mockImplementation((node: Node) => {
      capturedAnchor = node as HTMLAnchorElement
      return node
    })
    vi.spyOn(document.body, 'removeChild').mockImplementation((node: Node) => node)

    triggerJsonDownload('erasure-report-xyz.json', { a: 1 })

    expect(capturedAnchor).not.toBeNull()
    expect((capturedAnchor as unknown as HTMLAnchorElement).download).toBe(
      'erasure-report-xyz.json'
    )
    appendSpy.mockRestore()
  })
})
