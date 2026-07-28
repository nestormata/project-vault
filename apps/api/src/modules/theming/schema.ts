import { z } from 'zod/v4'

export const ThemeReloadFailureSchema = z.object({
  file: z.string(),
  reason: z.string(),
})

export const ThemeReloadResponseSchema = z.object({
  loaded: z.array(z.string()),
  failed: z.array(ThemeReloadFailureSchema),
})

export type ThemeReloadResponse = z.infer<typeof ThemeReloadResponseSchema>
