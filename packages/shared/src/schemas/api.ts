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

// Shared 409 body for "blocked by an in-progress credential rotation" (Story 4.3 AC-8 deactivation
// guard, Story 4.4 AC-4 archive guard). Both stub call sites must return this exact shape so
// clients handle either endpoint's block the same way once Epic 5 replaces the stubs.
export const ActiveRotationsErrorSchema = z
  .object({ error: z.literal('active_rotations'), rotationIds: z.array(z.uuid()) })
  .meta({ id: 'ActiveRotationsError' })

// Story 43-15 AC-8/AC-9 (FR102 explicit orphan handling): the optional body of
// POST /org/users/:userId/deactivate and DELETE /org/users/:userId. Absent (or `{}`) keeps the
// default `active_rotations` block; `abandon` abandons the target's staged/stale_recovery
// rotations and holds promoted/in_progress ones in the same transaction.
// Story 43-17 KD-3 (FR102 third outcome): `transfer` hands every blocking rotation the target owns
// to `transferToUserId` (one target per request), which is REQUIRED with `transfer` and forbidden
// otherwise. Both variants are `.strict()`: an unknown key, a target without `transfer`, or any
// other handling value (e.g. `hold`) is rejected, never ignored.
const AbandonOrBlockRotationHandlingSchema = z
  .object({ rotationHandling: z.literal('abandon').optional() })
  .strict()

const TransferRotationHandlingSchema = z
  .object({ rotationHandling: z.literal('transfer'), transferToUserId: z.uuid() })
  .strict()

export const RotationHandlingBodySchema = z
  .union([AbandonOrBlockRotationHandlingSchema, TransferRotationHandlingSchema])
  .meta({ id: 'RotationHandlingBody' })

export type RotationHandlingBody = z.infer<typeof RotationHandlingBodySchema>

// Story 7.2 D12/AC-23 — archive-guard block shape for active machine-user API keys, matching
// ActiveRotationsErrorSchema's `{ error, ... }` field-naming precedent (not `{ code, ... }`)
// since this is the same project-archival block-response family (4.4 ADR-4.4-04).
export const ActiveMachineUserKeysErrorSchema = z
  .object({
    error: z.literal('active_machine_user_keys'),
    machineUserIds: z.array(z.uuid()),
  })
  .meta({ id: 'ActiveMachineUserKeysError' })

// Story 17.1 AC-19 — archive-guard block shape for active credential shares, same `{ error, ... }`
// field-naming precedent as the two block-response schemas above.
export const ActiveSharesErrorSchema = z
  .object({
    error: z.literal('active_shares'),
    shareIds: z.array(z.uuid()),
  })
  .meta({ id: 'ActiveSharesError' })
