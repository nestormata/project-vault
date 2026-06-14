import { z } from 'zod'

export const ApiResponseSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    data: dataSchema,
    meta: z
      .object({
        page: z.number().optional(),
        limit: z.number().optional(),
        total: z.number().optional(),
        hasNext: z.boolean().optional(),
      })
      .optional(),
  })

export type ApiResponse<T> = {
  data: T
  meta?: {
    page?: number
    limit?: number
    total?: number
    hasNext?: boolean
  }
}

export const ApiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.array(z.string())).optional(),
})

export type ApiError = z.infer<typeof ApiErrorSchema>
