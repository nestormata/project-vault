import { describe, expect, it, vi } from 'vitest'
import { apiFetch } from './client.js'
import { jsonResponse } from '$lib/test/json-response.js'

describe('apiFetch', () => {
  it('sends Content-Type: application/json when a body is present', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: { ok: true } }))

    await apiFetch(fetchFn, '/api/v1/example', { method: 'POST', body: JSON.stringify({ a: 1 }) })

    expect(fetchFn).toHaveBeenCalledWith('/api/v1/example', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    })
  })

  // Regression guard: Fastify's default JSON body parser rejects a request that declares
  // `Content-Type: application/json` but sends no body at all — "Body cannot be empty when
  // content-type is set to 'application/json'" (FST_ERR_CTP_EMPTY_JSON_BODY). Every bodyless POST
  // helper (logout, refreshSession, enrollMfa, ...) was unconditionally sending that header,
  // so every one of those calls 400'd against the real API despite passing in mocked-fetch tests.
  it('omits Content-Type when there is no body, so bodyless POSTs do not 400 against a real JSON body parser', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: { ok: true } }))

    await apiFetch(fetchFn, '/api/v1/example', { method: 'POST' })

    expect(fetchFn).toHaveBeenCalledWith('/api/v1/example', {
      method: 'POST',
      credentials: 'include',
      headers: {},
    })
  })

  it('still lets a caller override headers explicitly even without a body', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: { ok: true } }))

    await apiFetch(fetchFn, '/api/v1/example', {
      method: 'POST',
      headers: { 'x-vault-bootstrap-token': 'abc' },
    })

    expect(fetchFn).toHaveBeenCalledWith('/api/v1/example', {
      method: 'POST',
      credentials: 'include',
      headers: { 'x-vault-bootstrap-token': 'abc' },
    })
  })
})
