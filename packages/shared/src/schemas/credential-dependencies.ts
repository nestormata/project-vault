import { z } from 'zod/v4'

export const SystemTypeSchema = z.enum([
  'service',
  'ci_pipeline',
  'database',
  'third_party',
  'other',
])

export const CredentialDependencySchema = z
  .object({
    id: z.uuid(),
    credentialId: z.uuid(),
    systemName: z.string(),
    systemType: SystemTypeSchema,
    notes: z.string().nullable(),
    linkUrl: z.url().nullable(),
    createdBy: z.uuid().nullable(),
    archivedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    // Story 13.5 AC-5/AC-6: the field this dependency is scoped to, or null for
    // whole-credential (unchanged default). Set only at creation time — see the story's Dev
    // Notes for why editing fieldKey after creation is out of scope.
    fieldKey: z.string().nullable(),
  })
  .meta({ id: 'CredentialDependency' })

export const CredentialAccessEntrySchema = z
  .object({
    identityType: z.enum(['user', 'machine_user']),
    displayName: z.string(),
    role: z.enum(['owner', 'admin', 'member', 'viewer']),
    grantedAt: z.iso.datetime(),
  })
  .meta({ id: 'CredentialAccessEntry' })

export type SystemType = z.infer<typeof SystemTypeSchema>
export type CredentialDependency = z.infer<typeof CredentialDependencySchema>
export type CredentialAccessEntry = z.infer<typeof CredentialAccessEntrySchema>
