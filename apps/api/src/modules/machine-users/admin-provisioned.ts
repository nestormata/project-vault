import { eq } from 'drizzle-orm'
import { machineUsers } from '@project-vault/db/schema'

/**
 * Story 73.9 (D1, AC-4) — `machine_users` holds two principals. Admin-provisioned rows belong to a
 * project and are the only ones that can hold API keys. Host-managed rows (the keyless principal
 * the host creates for an extension's credential-sharing writes) have no project, and every
 * by-id machine-user route treats them as unknown. The database CHECK
 * `machine_users_host_managed_shape_check` guarantees `project_id` for every admin-provisioned row.
 */
export const isAdminProvisioned = eq(machineUsers.hostManaged, false)

export type WithProjectId<T> = T & { projectId: string }

/**
 * Narrows rows read through an `api_keys` join (or filtered on `isAdminProvisioned`) to the
 * project-scoped shape. A key always belongs to an admin-provisioned row, so nothing is dropped.
 */
export function withProjectId<T extends { projectId: string | null }>(
  rows: T[]
): WithProjectId<T>[] {
  return rows.filter((row): row is WithProjectId<T> => row.projectId !== null)
}
