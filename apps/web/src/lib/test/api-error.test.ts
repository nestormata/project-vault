import { describe, expect, it } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'
import { apiClientError } from './api-error.js'

describe('apiClientError (Story 68.1 Q2)', () => {
  it('builds an ApiClientError that keeps endpoint-specific body fields', () => {
    const error = apiClientError(409, { code: 'conflict', rotationId: 'rot-1' }, 'conflict')
    expect(error).toBeInstanceOf(ApiClientError)
    expect(error.status).toBe(409)
    expect(error.code).toBe('conflict')
    expect(error.body).toEqual({ code: 'conflict', rotationId: 'rot-1' })
  })
})
