import { describe, expect, it } from 'vitest'
import { enumerateOperations, operationKey, type OpenApiDocument } from './load-spec.js'

const FIXTURE_SPEC: OpenApiDocument = {
  openapi: '3.0.0',
  info: { title: 'Fixture', version: '0.0.1' },
  paths: {
    '/health': {
      get: { responses: { '200': {} } },
    },
    '/api/v1/projects': {
      get: { responses: { '200': {} } },
      post: { responses: { '201': {} } },
    },
  },
}

describe('enumerateOperations (AC-8)', () => {
  it('enumerates one operation per path+method combination present in the spec', () => {
    const operations = enumerateOperations(FIXTURE_SPEC)
    expect(operations).toHaveLength(3)
    expect(operations.map(operationKey).sort()).toEqual([
      'GET /api/v1/projects',
      'GET /health',
      'POST /api/v1/projects',
    ])
  })

  it('does not enumerate a method that is not registered for a given path', () => {
    const operations = enumerateOperations(FIXTURE_SPEC)
    expect(operations.some((op) => op.method === 'delete' && op.path === '/health')).toBe(false)
  })

  it('returns an empty array for a spec with no paths', () => {
    expect(enumerateOperations({ ...FIXTURE_SPEC, paths: {} })).toEqual([])
  })
})
