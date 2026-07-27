import { z } from 'zod/v4'
import { FIELD_KEY_MAX_LENGTH, FIELD_KEY_PATTERN, FieldSchema } from '@project-vault/shared'

export const MachineCredentialParamsSchema = z
  .object({ projectId: z.uuid(), name: z.string().min(1) })
  .meta({ id: 'MachineCredentialParams' })

// Story 13.3 — mirrors CredentialValueQuerySchema (human route) for the machine reveal route's
// own `?field=` support (architecture.md's explicit statement this route gains it too).
export const MachineCredentialValueQuerySchema = z
  .object({
    field: z.string().trim().min(1).max(FIELD_KEY_MAX_LENGTH).regex(FIELD_KEY_PATTERN).optional(),
  })
  .strict()
  .meta({ id: 'MachineCredentialValueQuery' })
export type MachineCredentialValueQuery = z.infer<typeof MachineCredentialValueQuerySchema>

const machineCredentialValueDataBase = {
  name: z.string(),
  versionNumber: z.number().int().positive(),
  // AC-6: `cacheable` is present on EVERY successful response, not just non-cacheable ones — the
  // offline agent's non-cacheable-exclusion logic (AC-14) depends on this being part of the
  // baseline schema.
  cacheable: z.boolean(),
}

// Story 13.3 — discriminated response, mirroring the human `/value` route: legacy/single-
// default-field secrets keep the existing bare `{ value }` shape; a genuinely multi-field secret
// returns the structured `{ fields: [...] }` shape instead.
export const MachineCredentialValueResponseSchema = z
  .object({
    data: z.union([
      z.object({ ...machineCredentialValueDataBase, value: z.string() }),
      z.object({ ...machineCredentialValueDataBase, fields: z.array(FieldSchema) }),
    ]),
  })
  .meta({ id: 'MachineCredentialValueResponse' })

export const AmbiguousCredentialNameErrorSchema = z
  .object({
    code: z.literal('ambiguous_credential_name'),
    message: z.string(),
    matchCount: z.number().int().min(2),
  })
  .meta({ id: 'AmbiguousCredentialNameError' })

// Story 7.2 D13/AC-15 — the offline agent's fallback-mode activation beacon. `activatedAt` is the
// ISO-8601 timestamp fallback mode began (not the report time); `threshold` is the effective
// `VAULT_FALLBACK_THRESHOLD` that triggered it. `projectId` is not part of the body — it is
// already carried in the machine JWT's `scope` claim that authenticates the call.
export const CacheActivatedBodySchema = z
  .object({
    activatedAt: z.iso.datetime(),
    threshold: z.number().int().positive(),
  })
  .meta({ id: 'CacheActivatedBody' })

export const CacheActivatedResponseSchema = z
  .object({
    data: z.object({ recorded: z.literal(true) }),
  })
  .meta({ id: 'CacheActivatedResponse' })
