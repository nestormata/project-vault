import { SHARE_DISPLAY_STATUSES, type ShareDisplayStatus } from '@project-vault/shared'
import { injectActions, withInjectedLoad } from '$lib/server/composition/inject-behavior.js'
import { listSharesIndex } from '$lib/api/credential-shares.js'
import type { PageServerLoad } from './$types.js'

// Story 72.11 AC1: the shares index. The status filter and the page number are URL query
// parameters (a reload or a copied link keeps them); an unknown filter value reads as "All" and a
// bad page number as page 1, never an error page.
const SHARES_PAGE_SIZE = 25

function parseDisplayStatus(value: string | null): ShareDisplayStatus | null {
  return (SHARE_DISPLAY_STATUSES as readonly string[]).includes(value ?? '')
    ? (value as ShareDisplayStatus)
    : null
}

function parsePage(value: string | null): number {
  const page = Number(value ?? '1')
  return Number.isInteger(page) && page >= 1 ? page : 1
}

const ownLoad = (async ({ fetch, url }) => {
  const displayStatus = parseDisplayStatus(url.searchParams.get('displayStatus'))
  const page = parsePage(url.searchParams.get('page'))
  const result = await listSharesIndex(fetch, {
    ...(displayStatus ? { displayStatus } : {}),
    limit: SHARES_PAGE_SIZE,
    offset: (page - 1) * SHARES_PAGE_SIZE,
  })
  return {
    items: result.items,
    total: result.total,
    page,
    pageSize: SHARES_PAGE_SIZE,
    displayStatus,
  }
}) satisfies PageServerLoad

export const load: PageServerLoad = withInjectedLoad(ownLoad, '/(app)/shares', 'page')

export const actions = injectActions('/(app)/shares')
