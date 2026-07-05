import { z } from 'zod/v4'

export const MachineCredentialParamsSchema = z
  .object({ projectId: z.uuid(), name: z.string().min(1) })
  .meta({ id: 'MachineCredentialParams' })

// AC-6: `cacheable` is present on EVERY successful response, not just non-cacheable ones — the
// offline agent's non-cacheable-exclusion logic (AC-14) depends on this being part of the
// baseline schema.
export const MachineCredentialValueResponseSchema = z
  .object({
    data: z.object({
      name: z.string(),
      value: z.string(),
      versionNumber: z.number().int().positive(),
      cacheable: z.boolean(),
    }),
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
