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
