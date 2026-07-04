import { z } from 'zod/v4'

// Story 7.1 — mirrors MAX_CREDENTIAL_LIST_OFFSET's precedent (modules/credentials/schema.ts),
// shared here since both the machine-user list (AC-7) and the api-key list (AC-12) use it.
export const MAX_MACHINE_USER_LIST_OFFSET = 10_000

// UX-DR11: the scope-boundary block shown on creation (before any key exists) and detail views.
export const ScopeBoundarySchema = z
  .object({
    canAccess: z.array(z.string()),
    cannotAccess: z.array(z.string()),
  })
  .meta({ id: 'ScopeBoundary' })

export const MachineUserRoleSchema = z.enum(['member', 'viewer'])

const machineUserFields = {
  id: z.uuid(),
  projectId: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  role: MachineUserRoleSchema,
  createdBy: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  deactivatedAt: z.iso.datetime().nullable(),
}

// Used by the create (AC-3) and detail (AC-8) responses — both include scopeBoundary.
export const MachineUserDetailSchema = z
  .object({ ...machineUserFields, scopeBoundary: ScopeBoundarySchema })
  .meta({ id: 'MachineUserDetail' })

// Used by the list response (AC-7) — recomputing scopeBoundary per row adds no value there.
export const MachineUserSummarySchema = z
  .object(machineUserFields)
  .meta({ id: 'MachineUserSummary' })

// AC-9: the one-time plaintext-key-issue response. `key` is the plaintext and must never be
// persisted or logged (see Dev Notes) — this schema exists only to shape this single response.
export const ApiKeyIssuedSchema = z
  .object({
    id: z.uuid(),
    machineUserId: z.uuid(),
    name: z.string(),
    key: z.string(),
    expiresAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'ApiKeyIssued' })

// AC-12: metadata-only key list item. Explicit field allowlist (not `.strict()` on a superset)
// so a future SELECT * widening at the call site cannot leak keyHash/plaintext through here —
// `.parse()` on an object with extra keys silently drops them by default (Zod object semantics).
export const ApiKeyMetadataSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    expiresAt: z.iso.datetime().nullable(),
    lastUsedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    isRevoked: z.boolean(),
  })
  .meta({ id: 'ApiKeyMetadata' })

export type ScopeBoundary = z.infer<typeof ScopeBoundarySchema>
export type MachineUserRole = z.infer<typeof MachineUserRoleSchema>
export type MachineUserDetail = z.infer<typeof MachineUserDetailSchema>
export type MachineUserSummary = z.infer<typeof MachineUserSummarySchema>
export type ApiKeyIssued = z.infer<typeof ApiKeyIssuedSchema>
export type ApiKeyMetadata = z.infer<typeof ApiKeyMetadataSchema>
