import type { ShareDisplayStatus } from '@project-vault/shared'

/** The query string of a shares index link: empty for "All" on page 1, else `?displayStatus=..&page=..`. */
export function sharesIndexQuery(displayStatus: ShareDisplayStatus | null, page: number): string {
  const params = new URLSearchParams()
  if (displayStatus) params.set('displayStatus', displayStatus)
  if (page > 1) params.set('page', String(page))
  const serialized = params.toString()
  return serialized ? `?${serialized}` : ''
}
