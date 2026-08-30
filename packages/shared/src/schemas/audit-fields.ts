import { z } from 'zod/v4'

/**
 * Story 28.5 — shared trailing audit/archival fields for an archivable entity's Detail schema.
 * `credentials.ts`'s `CredentialDetailSchema` deliberately mirrors `projects.ts`'s
 * `ProjectDetailSchema` for this shape (Story 4.4's project-archive pattern) — formalized here so
 * the two schemas share one definition instead of two copies that could silently drift apart.
 */
export const archivableEntityAuditFields = {
  createdBy: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
}
