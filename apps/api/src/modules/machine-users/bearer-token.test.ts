import { describe, expect, it } from 'vitest'
import type { FastifyRequest } from 'fastify'
import { extractBearerToken } from './bearer-token.js'

function requestWithAuthHeader(authorization: string | undefined): FastifyRequest {
  return { headers: { authorization } } as unknown as FastifyRequest
}

describe('extractBearerToken', () => {
  it('extracts the token from a well-formed Authorization: Bearer header', () => {
    expect(extractBearerToken(requestWithAuthHeader('Bearer abc123'))).toBe('abc123')
  })

  it('returns null when the header is absent', () => {
    expect(extractBearerToken(requestWithAuthHeader(undefined))).toBeNull()
  })

  it('returns null when the header does not start with "Bearer "', () => {
    expect(extractBearerToken(requestWithAuthHeader('Basic abc123'))).toBeNull()
  })

  it('returns null when the token portion is empty or whitespace-only', () => {
    expect(extractBearerToken(requestWithAuthHeader('Bearer '))).toBeNull()
    expect(extractBearerToken(requestWithAuthHeader('Bearer    '))).toBeNull()
  })

  it('trims surrounding whitespace from the token', () => {
    expect(extractBearerToken(requestWithAuthHeader('Bearer  abc123  '))).toBe('abc123')
  })
})
