import { injectActions, withInjectedLoad } from '$lib/server/composition/inject-behavior.js'
import { fail } from '@sveltejs/kit'
import { isSupportedLocale } from '@project-vault/shared'
import { getUsersMe } from '$lib/api/inbox.js'
import { patchUserLocale } from '$lib/api/locale.js'
import { requireUser } from '$lib/server/require-user.js'
import { buildLocaleOptions } from './locale-settings-model.js'
import type { Actions, PageServerLoad } from './$types.js'

const ownLoad = (async ({ fetch, locals }) => {
  requireUser(locals)
  const me = await getUsersMe(fetch)
  return { options: buildLocaleOptions(me.locale) }
}) satisfies PageServerLoad

export const load: PageServerLoad = withInjectedLoad(ownLoad, '/(app)/settings/language', 'page')

const ownActions = {
  updateLocale: async ({ request, fetch }) => {
    const data = await request.formData()
    const locale = String(data.get('locale'))

    if (!isSupportedLocale(locale)) {
      return fail(422, { error: 'Unsupported locale' })
    }

    try {
      const result = await patchUserLocale(fetch, locale)
      return { success: true, locale: result.locale }
    } catch {
      return fail(422, { error: 'Failed to update language preference' })
    }
  },
} satisfies Actions

export const actions = {
  ...ownActions,
  ...injectActions('/(app)/settings/language'),
} satisfies Actions
