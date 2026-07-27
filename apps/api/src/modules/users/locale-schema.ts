import { z } from 'zod/v4'
import { SUPPORTED_LOCALES } from '@project-vault/shared'

/**
 * Story 15.1 AC 6/8 — `.strict()` so an extra `userId` field (or any other unexpected field) is
 * rejected outright rather than silently ignored: the endpoint derives its target row exclusively
 * from `secureCtx.auth.userId`, never from client input, so there is nothing to tamper with — but
 * `.strict()` still makes an attempted `userId` field a hard 422 rather than a silent no-op,
 * matching `organization-settings-schema.ts`'s established convention.
 */
export const UserLocaleBodySchema = z
  .object({ locale: z.enum(SUPPORTED_LOCALES) })
  .strict()
  .meta({ id: 'UserLocaleBody' })

export const UserLocaleResponseSchema = z
  .object({ data: z.object({ locale: z.enum(SUPPORTED_LOCALES) }) })
  .meta({ id: 'UserLocaleResponse' })
