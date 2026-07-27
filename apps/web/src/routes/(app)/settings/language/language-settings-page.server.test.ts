import { beforeEach, describe, expect, it, vi } from 'vitest'

const getUsersMeMock = vi.hoisted(() => vi.fn())
const patchUserLocaleMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/inbox.js', () => ({ getUsersMe: getUsersMeMock }))
vi.mock('$lib/api/locale.js', () => ({ patchUserLocale: patchUserLocaleMock }))

import { actions, load } from './+page.server.js'

function makeEvent(user: { orgRole: string } | null) {
  return { fetch: vi.fn(), locals: { user } } as unknown as Parameters<typeof load>[0]
}

function actionEvent(fields: Record<string, string> = {}) {
  const formData = new FormData()
  for (const [key, value] of Object.entries(fields)) formData.set(key, value)
  return {
    request: { formData: async () => formData },
    fetch: vi.fn(),
    locals: { user: { orgRole: 'member' } },
  } as unknown as Parameters<(typeof actions)['updateLocale']>[0]
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('/settings/language +page.server.ts load (AC 1/7)', () => {
  it('builds locale options from the current users.locale value, redirecting anonymous users', async () => {
    getUsersMeMock.mockResolvedValue({ locale: 'es' })

    const result = await load(makeEvent({ orgRole: 'member' }))

    expect(result.options).toEqual([
      { locale: 'en', label: 'English', isCurrent: false },
      { locale: 'es', label: 'Español', isCurrent: true },
    ])
  })

  it('redirects an anonymous request to /login (requireUser)', async () => {
    await expect(load(makeEvent(null))).rejects.toMatchObject({ status: 303 })
  })
})

describe('/settings/language +page.server.ts actions (AC 2/6/8)', () => {
  it('updateLocale succeeds and forwards the chosen locale', async () => {
    patchUserLocaleMock.mockResolvedValue({ locale: 'es' })

    const result = await actions.updateLocale(actionEvent({ locale: 'es' }))

    expect(patchUserLocaleMock).toHaveBeenCalledWith(expect.any(Function), 'es')
    expect(result).toEqual({ success: true, locale: 'es' })
  })

  it('rejects an unsupported locale with a 422 before ever calling the API (AC 6 edge)', async () => {
    const result = await actions.updateLocale(actionEvent({ locale: 'xx' }))

    expect(patchUserLocaleMock).not.toHaveBeenCalled()
    expect(result).toEqual({ status: 422, data: { error: 'Unsupported locale' } })
  })

  it('returns a 422 failure when the API call rejects', async () => {
    patchUserLocaleMock.mockRejectedValue(new Error('network down'))

    const result = await actions.updateLocale(actionEvent({ locale: 'es' }))

    expect(result).toEqual({
      status: 422,
      data: { error: 'Failed to update language preference' },
    })
  })
})
