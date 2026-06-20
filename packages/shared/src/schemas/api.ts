import { z } from 'zod/v4'

function isLowerSnakeCase(value: string): boolean {
  if (value.length === 0) {
    return false
  }

  return value
    .split('_')
    .every((segment) => segment.length > 0 && [...segment].every(isLowercaseAlphaNumeric))
}

function isLowercaseAlphaNumeric(char: string): boolean {
  return (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9')
}

export const ApiResponseMetaSchema = z
  .object({
    page: z.number().optional(),
    limit: z.number().optional(),
    total: z.number().optional(),
    hasNext: z.boolean().optional(),
  })
  .meta({ id: 'ApiResponseMeta' })

export const ApiResponseSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    data: dataSchema,
    meta: ApiResponseMetaSchema.optional(),
  })

export type ApiResponse<T> = {
  data: T
  meta?: z.infer<typeof ApiResponseMetaSchema>
}

export const ApiErrorSchema = z
  .object({
    code: z.string().refine(isLowerSnakeCase, 'ApiError.code must be lower snake_case'),
    message: z.string(),
    details: z.record(z.string(), z.array(z.string())).optional(),
  })
  .meta({ id: 'ApiError' })

export type ApiError = z.infer<typeof ApiErrorSchema>
