import { injectActions, withInjectedLoad } from '$lib/server/composition/inject-behavior.js'
import type { PageServerLoad } from './$types.js'
import { platformOperatorGate } from '$lib/server/require-platform-operator.js'
import { listBackups, type BackupListItem } from '$lib/api/platform.js'
import { ApiClientError } from '$lib/api/client.js'

async function fetchBackupsData(fetch: typeof globalThis.fetch) {
  try {
    const result = await listBackups(fetch)
    return { backups: result.items, errorMessage: null as string | null }
  } catch (err) {
    return {
      backups: [] as BackupListItem[],
      errorMessage:
        err instanceof ApiClientError
          ? (err.message ?? 'Failed to load backups')
          : 'Failed to load backups',
    }
  }
}

const ownLoad = (async ({ fetch, locals }) => {
  const { allowed } = platformOperatorGate(locals)
  if (!allowed) return { allowed: false as const }
  return { allowed: true as const, ...(await fetchBackupsData(fetch)) }
}) satisfies PageServerLoad

export const load: PageServerLoad = withInjectedLoad(ownLoad, '/(app)/platform/backups', 'page')

export const actions = injectActions('/(app)/platform/backups')
