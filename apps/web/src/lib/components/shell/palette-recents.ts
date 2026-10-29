import { ApiClientError } from '$lib/api/client.js'
import { getCredential } from '$lib/api/credentials.js'
import { getProject } from '$lib/api/projects.js'

// Story 72.5 (P12): recents of the command palette. They live in memory only (a reload clears
// them), hold ids and display names, and are keyed by the signed-in user so another user in the same
// tab never sees them. A recent is never trusted: it is re-checked on the server before it is shown
// and again on selection, and an item the user can no longer open is dropped (a recent never
// reveals a record the user can no longer open).

export type RecentItem =
  | { type: 'credential'; id: string; projectId: string; name: string; projectName: string }
  | { type: 'project'; id: string; name: string }

export const MAX_RECENTS = 5

let owner: string | null = null
let items: RecentItem[] = []

function sameItem(a: RecentItem, b: RecentItem): boolean {
  return a.type === b.type && a.id === b.id
}

function adopt(userId: string): void {
  if (owner !== userId) {
    owner = userId
    items = []
  }
}

export function readRecents(userId: string): RecentItem[] {
  adopt(userId)
  return [...items]
}

export function addRecent(userId: string, item: RecentItem): void {
  adopt(userId)
  items = [item, ...items.filter((existing) => !sameItem(existing, item))].slice(0, MAX_RECENTS)
}

export function removeRecent(userId: string, item: RecentItem): void {
  adopt(userId)
  items = items.filter((existing) => !sameItem(existing, item))
}

export function clearRecents(): void {
  owner = null
  items = []
}

export type RecentCheck =
  | { status: 'ok'; projectRole?: string | null; isArchived?: boolean }
  | { status: 'gone' }
  | { status: 'unknown' }

/**
 * Asks the server whether the user can still open the item (the same read the page itself makes).
 * 403 and 404 mean gone; any other failure is `unknown`, and the caller fails closed (not shown, not
 * opened) without forgetting the item.
 */
export async function checkRecent(fetchFn: typeof fetch, item: RecentItem): Promise<RecentCheck> {
  try {
    if (item.type === 'project') {
      const project = await getProject(fetchFn, item.id)
      return { status: 'ok', projectRole: project.role, isArchived: project.archivedAt !== null }
    }
    await getCredential(fetchFn, item.projectId, item.id)
    return { status: 'ok' }
  } catch (error) {
    if (error instanceof ApiClientError && (error.status === 403 || error.status === 404)) {
      return { status: 'gone' }
    }
    return { status: 'unknown' }
  }
}
