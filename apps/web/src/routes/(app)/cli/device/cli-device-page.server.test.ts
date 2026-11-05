import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'
import { getCurrentUser } from '$lib/api/auth.js'
import { decideCliDeviceLogin } from '$lib/api/cli-device.js'
import { requireUser } from '$lib/server/require-user.js'
import { actions, load } from './+page.server.js'
import { expectLoaded } from '$lib/test/page-data.js'

vi.mock('$lib/api/auth.js', () => ({ getCurrentUser: vi.fn() }))
vi.mock('$lib/api/cli-device.js', () => ({ decideCliDeviceLogin: vi.fn() }))
vi.mock('$lib/server/require-user.js', () => ({ requireUser: vi.fn() }))

const getCurrentUserMock = vi.mocked(getCurrentUser)
const decideCliDeviceLoginMock = vi.mocked(decideCliDeviceLogin)
const requireUserMock = vi.mocked(requireUser)

function loadEvent(code: string | null = null) {
  return {
    fetch: vi.fn(),
    locals: {},
    url: new URL(`https://vault.example.com/cli/device${code ? `?code=${code}` : ''}`),
  } as unknown as Parameters<typeof load>[0]
}

function actionEvent(fields: Record<string, string>) {
  const body = new FormData()
  for (const [key, value] of Object.entries(fields)) body.set(key, value)
  return {
    request: { formData: async () => body },
    fetch: vi.fn(),
    locals: {},
  } as unknown as Parameters<(typeof actions)['decide']>[0]
}

describe('/cli/device +page.server.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireUserMock.mockReturnValue({ userId: 'user-1' } as ReturnType<typeof requireUser>)
  })

  it('requires a signed-in user and loads a normalized code plus platform-operator status', async () => {
    getCurrentUserMock.mockResolvedValue({ isPlatformOperator: true } as Awaited<
      ReturnType<typeof getCurrentUser>
    >)

    const result = expectLoaded(await load(loadEvent('bcdf-ghjk')))

    expect(requireUserMock).toHaveBeenCalledWith({})
    expect(getCurrentUserMock).toHaveBeenCalledOnce()
    expect(result).toEqual({ code: 'BCDF-GHJK', isPlatformOperator: true })
  })

  it('leaves an absent or invalid code blank', async () => {
    getCurrentUserMock.mockResolvedValue({ isPlatformOperator: false } as Awaited<
      ReturnType<typeof getCurrentUser>
    >)

    expect(expectLoaded(await load(loadEvent())).code).toBe('')
    expect(expectLoaded(await load(loadEvent('bad-code'))).code).toBe('')
  })

  it('approves with a trimmed authenticator code and returns the API outcome', async () => {
    decideCliDeviceLoginMock.mockResolvedValue({ status: 'approved' })
    const event = actionEvent({ userCode: 'ABCD-EFGH', decision: 'approve', totpCode: ' 123456 ' })

    const result = await actions.decide(event)

    expect(decideCliDeviceLoginMock).toHaveBeenCalledWith(event.fetch, {
      userCode: 'ABCD-EFGH',
      decision: 'approve',
      totpCode: '123456',
    })
    expect(result).toEqual({ outcome: 'approved' })
  })

  it('denies without sending an empty authenticator code', async () => {
    decideCliDeviceLoginMock.mockResolvedValue({ status: 'denied' })
    const event = actionEvent({ userCode: 'ABCD-EFGH', decision: 'deny', totpCode: '   ' })

    const result = await actions.decide(event)

    expect(decideCliDeviceLoginMock).toHaveBeenCalledWith(event.fetch, {
      userCode: 'ABCD-EFGH',
      decision: 'deny',
    })
    expect(result).toEqual({ outcome: 'denied' })
  })

  it('treats any non-deny decision as approval', async () => {
    decideCliDeviceLoginMock.mockResolvedValue({ status: 'approved' })

    await actions.decide(actionEvent({ userCode: 'ABCD-EFGH', decision: 'unexpected' }))

    expect(decideCliDeviceLoginMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ decision: 'approve' })
    )
  })

  it('returns an API error status and code as an action failure', async () => {
    decideCliDeviceLoginMock.mockRejectedValue(
      new ApiClientError(401, { code: 'step_up_required' }, 'step-up')
    )

    const result = await actions.decide(actionEvent({ userCode: 'ABCD-EFGH', decision: 'approve' }))

    expect(result).toMatchObject({ status: 401, data: { outcome: 'step_up_required' } })
  })

  it('turns unknown exceptions into a generic 500 action failure', async () => {
    decideCliDeviceLoginMock.mockRejectedValue(new Error('private driver detail'))

    const result = await actions.decide(actionEvent({ userCode: 'ABCD-EFGH', decision: 'approve' }))

    expect(result).toMatchObject({ status: 500, data: { outcome: 'error' } })
    expect(JSON.stringify(result)).not.toContain('private driver detail')
  })
})
