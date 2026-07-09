import type { PageServerLoad } from './$types.js'
import { platformOperatorGate } from '$lib/server/require-platform-operator.js'
import { listBackups, type BackupListItem } from '$lib/api/platform.js'
import { ApiClientError } from '$lib/api/client.js'

export const load: PageServerLoad = async ({ fetch, locals }) => {
  const gate = platformOperatorGate(locals)
  if (!gate.allowed) return { allowed: false as const }

  try {
    const result = await listBackups(fetch)
    return {
      allowed: true as const,
      backups: result.items,
      errorMessage: null as string | null,
    }
  } catch (err) {
    const errorMessage =
      err instanceof ApiClientError
        ? (err.message ?? 'Failed to load backups')
        : 'Failed to load backups'
    return {
      allowed: true as const,
      backups: [] as BackupListItem[],
      errorMessage,
    }
  }
}
