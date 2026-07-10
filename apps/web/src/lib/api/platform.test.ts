import { describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '$lib/test/json-response.js'
import {
  fetchHealth,
  fetchReady,
  listPlatformAuditEvents,
  probeApiDocsEnabled,
} from './platform.js'

describe('fetchReady', () => {
  it('returns the parsed ready body on success', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ status: 'ready' }))
    expect(await fetchReady(fetchFn)).toEqual({ status: 'ready' })
  })

  it('falls back to ready when the body cannot be parsed', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('not json'))
    expect(await fetchReady(fetchFn)).toEqual({ status: 'ready' })
  })

  it('falls back to ready when the fetch itself rejects (network failure)', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('network down'))
    expect(await fetchReady(fetchFn)).toEqual({ status: 'ready' })
  })
})

describe('fetchHealth', () => {
  it('returns the parsed health body on a 200 response', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ status: 'ok', version: '1.2.3' }))
    expect(await fetchHealth(fetchFn)).toEqual({ status: 'ok', version: '1.2.3' })
  })

  it('returns null when the response is not ok', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ status: 'error' }, { status: 503 }))
    expect(await fetchHealth(fetchFn)).toBeNull()
  })

  it('returns null when the ok body cannot be parsed', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }))
    expect(await fetchHealth(fetchFn)).toBeNull()
  })

  it('returns null when the fetch itself rejects', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('network down'))
    expect(await fetchHealth(fetchFn)).toBeNull()
  })
})

describe('listPlatformAuditEvents filter params', () => {
  it('sends no query string when no filters are given', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: { items: [] } }))
    await listPlatformAuditEvents(fetchFn)
    const url = fetchFn.mock.calls[0][0] as string
    expect(url).toBe('/api/v1/platform/audit/events')
  })

  it('includes every provided filter in the query string', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: { items: [] } }))
    await listPlatformAuditEvents(fetchFn, {
      operatorId: 'op-1',
      actionType: 'org.create',
      targetOrgId: 'org-1',
      targetUserId: 'user-1',
      from: '2026-01-01',
      to: '2026-01-31',
      page: 2,
      limit: 50,
    })
    const url = fetchFn.mock.calls[0][0] as string
    expect(url).toContain('operatorId=op-1')
    expect(url).toContain('actionType=org.create')
    expect(url).toContain('targetOrgId=org-1')
    expect(url).toContain('targetUserId=user-1')
    expect(url).toContain('from=2026-01-01')
    expect(url).toContain('to=2026-01-31')
    expect(url).toContain('page=2')
    expect(url).toContain('limit=50')
  })

  it('omits page/limit from the query string when they are falsy (e.g. page 0)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: { items: [] } }))
    await listPlatformAuditEvents(fetchFn, { page: 0, limit: 0 })
    const url = fetchFn.mock.calls[0][0] as string
    expect(url).toBe('/api/v1/platform/audit/events')
  })
})

describe('probeApiDocsEnabled', () => {
  it('returns true when the openapi probe responds ok', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    expect(await probeApiDocsEnabled(fetchFn)).toBe(true)
  })

  it('returns false when the openapi probe responds not-ok', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('{}', { status: 404 }))
    expect(await probeApiDocsEnabled(fetchFn)).toBe(false)
  })

  it('returns false when the probe fetch rejects', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('network down'))
    expect(await probeApiDocsEnabled(fetchFn)).toBe(false)
  })
})
