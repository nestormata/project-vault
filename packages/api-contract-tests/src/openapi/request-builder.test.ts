import { describe, expect, it } from 'vitest'
import { buildPath, buildQueryString, buildRequestBody } from './request-builder.js'

describe('buildPath', () => {
  it('fills a known fixture path param by name', () => {
    const path = buildPath('/api/v1/projects/{projectId}', { projectId: 'fixture-project-id' })
    expect(path).toBe('/api/v1/projects/fixture-project-id')
  })

  it('falls back to a random UUID for an unrecognized ID-shaped path param', () => {
    const path = buildPath('/api/v1/machine-users/{machineUserId}', {})
    expect(path).toMatch(
      /^\/api\/v1\/machine-users\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
  })

  it('falls back to a fixed opaque string for a known non-UUID path param (token/filename/name)', () => {
    expect(buildPath('/api/v1/invitations/{token}', {})).toBe(
      '/api/v1/invitations/contract-test-nonexistent-value'
    )
  })

  it('fills multiple path params in the same path', () => {
    const path = buildPath('/api/v1/projects/{projectId}/credentials/{credentialId}', {
      projectId: 'p1',
      credentialId: 'c1',
    })
    expect(path).toBe('/api/v1/projects/p1/credentials/c1')
  })

  it('leaves a path with no params unchanged', () => {
    expect(buildPath('/api/v1/search', {})).toBe('/api/v1/search')
  })
})

describe('buildQueryString', () => {
  it('returns an empty string when there are no parameters', () => {
    expect(buildQueryString(undefined)).toBe('')
    expect(buildQueryString([])).toBe('')
  })

  it('sets a minimal value for every required query parameter', () => {
    const qs = buildQueryString([
      { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
      { name: 'limit', in: 'query', required: true, schema: { type: 'integer' } },
    ])
    const params = new URLSearchParams(qs.replace(/^\?/, ''))
    expect(params.get('q')).toBe('test')
    expect(params.get('limit')).toBe('1')
  })

  it('leaves optional query parameters unset (exercises the real default, e.g. page=1/limit=20)', () => {
    const qs = buildQueryString([
      { name: 'page', in: 'query', required: false, schema: { type: 'integer' } },
    ])
    expect(qs).toBe('')
  })

  it('ignores non-query (path) parameters', () => {
    const qs = buildQueryString([
      { name: 'projectId', in: 'path', required: true, schema: { type: 'string' } },
    ])
    expect(qs).toBe('')
  })

  it('uses the first enum value for a required string parameter with an enum', () => {
    const qs = buildQueryString([
      {
        name: 'status',
        in: 'query',
        required: true,
        schema: { type: 'string', enum: ['unread', 'read', 'all'] },
      },
    ])
    expect(qs).toBe('?status=unread')
  })
})

describe('buildRequestBody', () => {
  it('returns undefined when the operation has no documented requestBody', () => {
    expect(buildRequestBody({ responses: {} })).toBeUndefined()
  })

  it('returns an empty object when the operation documents a requestBody (D6/AC-9 — a minimal body is expected to land on a documented 422, not a fixture-generation failure)', () => {
    expect(
      buildRequestBody({
        responses: {},
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
      })
    ).toEqual({})
  })
})
