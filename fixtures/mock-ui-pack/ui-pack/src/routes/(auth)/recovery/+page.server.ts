import { fail } from '@sveltejs/kit'
import { injectActions, injectLoad } from '$lib/server/composition/inject-behavior.js'
import type { Actions, PageServerLoad } from './$types.js'

// M1 (b): a PUBLIC page override with its own server `load` and form `actions`.
export const load: PageServerLoad = async (event) => ({
  ...(await injectLoad(event, '/(auth)/recovery', 'page')),
  mockRecovery: 'mock-ui-pack:m1-recovery-load',
})

export const actions = {
  ...injectActions('/(auth)/recovery'),
  ping: async ({ request }) => {
    const form = await request.formData()
    const word = String(form.get('word') ?? '').trim()
    if (word === '') return fail(422, { mockPingError: 'mock-ui-pack:m1-recovery-ping-empty' })
    return { mockPong: `mock-ui-pack:m1-recovery-pong:${word}` }
  },
} satisfies Actions
