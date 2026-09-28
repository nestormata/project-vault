import { describe, it, expect } from 'vitest'
import { ApiErrorSchema, ApiResponseSchema, RotationHandlingBodySchema } from './api.js'
import { z } from 'zod/v4'

describe('ApiResponse', () => {
  it('validates a successful response', () => {
    const schema = ApiResponseSchema(z.object({ id: z.string() }))
    const result = schema.safeParse({ data: { id: '123' } })
    expect(result.success).toBe(true)
  })

  it('validates response with meta', () => {
    const schema = ApiResponseSchema(z.array(z.string()))
    const result = schema.safeParse({
      data: ['a', 'b'],
      meta: { page: 1, limit: 10, total: 2, hasNext: false },
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid data', () => {
    const schema = ApiResponseSchema(z.object({ id: z.string() }))
    const result = schema.safeParse({ data: { id: 123 } })
    expect(result.success).toBe(false)
  })
})

describe('ApiError', () => {
  it('validates a well-formed error', () => {
    const result = ApiErrorSchema.safeParse({
      code: 'slug_taken',
      message: 'That slug is already taken',
    })
    expect(result.success).toBe(true)
  })

  it('validates an error with details', () => {
    const result = ApiErrorSchema.safeParse({
      code: 'validation_error',
      message: 'Validation failed',
      details: { email: ['Invalid format'] },
    })
    expect(result.success).toBe(true)
  })

  it('rejects error missing code', () => {
    const result = ApiErrorSchema.safeParse({ message: 'Oops' })
    expect(result.success).toBe(false)
  })

  it('rejects codes that are not lower snake_case', () => {
    const result = ApiErrorSchema.safeParse({
      code: 'ValidationError',
      message: 'Validation failed',
    })
    expect(result.success).toBe(false)
  })
})

// Story 43-15 AC-8/AC-9: the optional deactivate/remove body — `abandon` is the only accepted
// value, and `.strict()` rejects unknown keys instead of silently falling back to the block.
describe('RotationHandlingBody', () => {
  it('accepts an empty body and the abandon literal', () => {
    expect(RotationHandlingBodySchema.safeParse({}).success).toBe(true)
    expect(RotationHandlingBodySchema.safeParse({ rotationHandling: 'abandon' }).success).toBe(true)
  })

  it('rejects any other handling value (no transfer, no silent fallback)', () => {
    expect(RotationHandlingBodySchema.safeParse({ rotationHandling: 'transfer' }).success).toBe(
      false
    )
  })

  it('rejects unknown keys', () => {
    expect(RotationHandlingBodySchema.safeParse({ handling: 'abandon' }).success).toBe(false)
  })
})
