import { fail } from '@sveltejs/kit'
import { injectActions, withInjectedLoad } from '$lib/server/composition/inject-behavior.js'
import { ApiClientError } from '$lib/api/client.js'
import { getCurrentUser } from '$lib/api/auth.js'
import { decideCliDeviceLogin } from '$lib/api/cli-device.js'
import { prefilledUserCode } from '$lib/cli-device-code.js'
import { requireUser } from '$lib/server/require-user.js'
import type { Actions, PageServerLoad } from './$types.js'

const ownLoad = (async ({ fetch, locals, url }) => {
  requireUser(locals)
  const me = await getCurrentUser(fetch)
  return {
    code: prefilledUserCode(url.searchParams.get('code')),
    isPlatformOperator: me.isPlatformOperator,
  }
}) satisfies PageServerLoad

export const load: PageServerLoad = withInjectedLoad(ownLoad, '/(app)/cli/device', 'page')

const ownActions = {
  decide: async ({ request, fetch, locals }) => {
    requireUser(locals)
    const form = await request.formData()
    const userCode = String(form.get('userCode') ?? '')
    const decision = form.get('decision') === 'deny' ? 'deny' : 'approve'
    const totpCode = String(form.get('totpCode') ?? '').trim()
    try {
      const result = await decideCliDeviceLogin(fetch, {
        userCode,
        decision,
        ...(totpCode ? { totpCode } : {}),
      })
      return { outcome: result.status }
    } catch (error) {
      const code = error instanceof ApiClientError ? error.code : undefined
      return fail(error instanceof ApiClientError ? error.status : 500, {
        outcome: code ?? 'error',
      })
    }
  },
} satisfies Actions

export const actions = {
  ...ownActions,
  ...injectActions('/(app)/cli/device'),
} satisfies Actions
