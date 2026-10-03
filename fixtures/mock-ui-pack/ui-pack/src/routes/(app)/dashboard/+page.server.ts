import { fail, redirect } from '@sveltejs/kit'
import { injectActions, withInjectedLoad } from '$lib/server/composition/inject-behavior.js'
import type { Actions, PageServerLoad } from './$types.js'

// M1 (a): an authenticated page override WITH its server `load` and form `actions` (the shape of
// CentralizeMe's phase-1 dashboard), including a 303 redirect branch. Data comes from the real API
// through the authenticated `event.fetch`, never through a client of the pack's own.
const ownLoad = (async ({ fetch, url }) => {
  if (url.searchParams.get('mock-redirect') === '1') redirect(303, '/settings')
  const response = await fetch('/api/v1/auth/me')
  const body = (await response.json()) as { data?: { userId?: string; orgName?: string } }
  return {
    mockDashboard: 'mock-ui-pack:m1-dashboard-load',
    mockUserId: body.data?.userId ?? null,
    mockOrgName: body.data?.orgName ?? null,
  }
}) satisfies PageServerLoad

export const load: PageServerLoad = withInjectedLoad(ownLoad, '/(app)/dashboard', 'page')

export const actions = {
  ...injectActions('/(app)/dashboard'),
  note: async ({ request }) => {
    const form = await request.formData()
    const note = String(form.get('note') ?? '').trim()
    if (note === '') return fail(422, { mockNoteError: 'mock-ui-pack:m1-dashboard-note-empty' })
    return { mockNote: `mock-ui-pack:m1-dashboard-note:${note}` }
  },
} satisfies Actions
