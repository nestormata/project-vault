import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'

const invalidateAllMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const issueApiKeyMock = vi.hoisted(() => vi.fn())
const revokeApiKeyMock = vi.hoisted(() => vi.fn())
const rotateApiKeyMock = vi.hoisted(() => vi.fn())
const emergencyRevokeApiKeyMock = vi.hoisted(() => vi.fn())
const deactivateMachineUserMock = vi.hoisted(() => vi.fn())

vi.mock('$app/navigation', () => ({
  invalidateAll: invalidateAllMock,
}))

vi.mock('$app/paths', () => ({
  resolve: (path: string) => path,
}))

vi.mock('$lib/api/machine-users.js', () => ({
  issueApiKey: issueApiKeyMock,
  revokeApiKey: revokeApiKeyMock,
  rotateApiKey: rotateApiKeyMock,
  emergencyRevokeApiKey: emergencyRevokeApiKeyMock,
  deactivateMachineUser: deactivateMachineUserMock,
}))

import { ApiClientError } from '$lib/api/client.js'
import MachineUserDetailPage from './+page.svelte'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  invalidateAllMock.mockClear()
  issueApiKeyMock.mockReset()
  revokeApiKeyMock.mockReset()
  rotateApiKeyMock.mockReset()
  emergencyRevokeApiKeyMock.mockReset()
  deactivateMachineUserMock.mockReset()
})

const projectId = 'proj-1'
const machineUserId = 'mu-1'

function baseMachineUser(overrides: Record<string, unknown> = {}) {
  return {
    id: machineUserId,
    projectId,
    name: 'ci-deploy-bot',
    description: null,
    role: 'member',
    createdAt: '2026-01-01T00:00:00.000Z',
    deactivatedAt: null,
    scopeBoundary: { canAccess: ['read secrets'], cannotAccess: ['write secrets'] },
    ...overrides,
  }
}

function baseData(overrides: Record<string, unknown> = {}) {
  return {
    projectId,
    machineUserId,
    orgRole: 'admin',
    machineUser: baseMachineUser(),
    apiKeys: { items: [], total: 0 },
    notFound: false,
    ...overrides,
  }
}

describe('machine-user detail +page.svelte', () => {
  it('renders the not-found banner when notFound is true', () => {
    render(MachineUserDetailPage, {
      props: { data: baseData({ notFound: true, machineUser: null }) },
    })

    expect(screen.getByText(/machine user not found/i)).toBeTruthy()
    const link = screen.getByRole('link', { name: /back to machine users/i })
    expect(link.getAttribute('href')).toBe(`/projects/${projectId}/machine-users`)
  })

  it('renders the not-found banner when machineUser is null even if notFound is false', () => {
    render(MachineUserDetailPage, { props: { data: baseData({ machineUser: null }) } })

    expect(screen.getByText(/machine user not found/i)).toBeTruthy()
  })

  it('shows Active badge and description when present', () => {
    render(MachineUserDetailPage, {
      props: {
        data: baseData({
          machineUser: baseMachineUser({ description: 'Runs CI deploys' }),
        }),
      },
    })

    expect(screen.getByText('Active')).toBeTruthy()
    expect(screen.getByText('Runs CI deploys')).toBeTruthy()
    expect(screen.getByText('ci-deploy-bot')).toBeTruthy()
  })

  it('omits the description paragraph when description is null', () => {
    render(MachineUserDetailPage, { props: { data: baseData() } })

    expect(screen.queryByText('Runs CI deploys')).toBeNull()
  })

  it('shows Deactivated badge, hides deactivate control and issue-key section, when machine user is deactivated', () => {
    render(MachineUserDetailPage, {
      props: {
        data: baseData({
          machineUser: baseMachineUser({ deactivatedAt: '2026-02-01T00:00:00.000Z' }),
        }),
      },
    })

    expect(screen.getByText('Deactivated')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^deactivate$/i })).toBeNull()
    expect(screen.queryByRole('heading', { name: /issue a new api key/i })).toBeNull()
  })

  it('renders scope boundary canAccess/cannotAccess lists', () => {
    render(MachineUserDetailPage, {
      props: {
        data: baseData({
          machineUser: baseMachineUser({
            scopeBoundary: { canAccess: ['read a', 'read b'], cannotAccess: ['write a'] },
          }),
        }),
      },
    })

    expect(screen.getByText('read a')).toBeTruthy()
    expect(screen.getByText('read b')).toBeTruthy()
    expect(screen.getByText('write a')).toBeTruthy()
  })

  it('formats createdAt as a locale date string, and formats null dates as an em dash', () => {
    render(MachineUserDetailPage, {
      props: {
        data: baseData({
          machineUser: baseMachineUser({ createdAt: '2026-01-01T00:00:00.000Z' }),
          apiKeys: {
            items: [
              {
                id: 'key-1',
                name: 'ci key',
                isRevoked: false,
                expiresAt: null,
                lastUsedAt: null,
              },
            ],
            total: 1,
          },
        }),
      },
    })

    expect(screen.getByText(new Date('2026-01-01T00:00:00.000Z').toLocaleString())).toBeTruthy()
    expect(screen.getByText(/expires\s*—\s*·\s*last used\s*—/i)).toBeTruthy()
  })

  it('hides manage-only controls (deactivate, issue key, rotate/revoke) for a non-managing role (viewer)', () => {
    render(MachineUserDetailPage, {
      props: {
        data: baseData({
          orgRole: 'viewer',
          apiKeys: {
            items: [
              { id: 'key-1', name: 'ci key', isRevoked: false, expiresAt: null, lastUsedAt: null },
            ],
            total: 1,
          },
        }),
      },
    })

    expect(screen.queryByRole('button', { name: /^deactivate$/i })).toBeNull()
    expect(screen.queryByRole('heading', { name: /issue a new api key/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^rotate$/i })).toBeNull()
  })

  it('shows "No API keys have been issued yet" for an empty key list', () => {
    render(MachineUserDetailPage, { props: { data: baseData() } })

    expect(screen.getByText(/no api keys have been issued yet/i)).toBeTruthy()
  })

  it('renders a Revoked badge for a revoked key and hides its rotate/revoke controls even for a manager', () => {
    render(MachineUserDetailPage, {
      props: {
        data: baseData({
          apiKeys: {
            items: [
              { id: 'key-1', name: 'old key', isRevoked: true, expiresAt: null, lastUsedAt: null },
            ],
            total: 1,
          },
        }),
      },
    })

    expect(screen.getByText('Revoked')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^rotate$/i })).toBeNull()
  })

  it('renders an Active badge with rotate/emergency-revoke/revoke controls for a non-revoked key when manager', () => {
    render(MachineUserDetailPage, {
      props: {
        data: baseData({
          apiKeys: {
            items: [
              { id: 'key-1', name: 'ci key', isRevoked: false, expiresAt: null, lastUsedAt: null },
            ],
            total: 1,
          },
        }),
      },
    })

    expect(screen.getByRole('button', { name: /^rotate$/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /emergency revoke/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^revoke$/i })).toBeTruthy()
  })

  it('AC-2/AC-3: issuing a key shows the plaintext key exactly once, clears the form, and invalidates', async () => {
    issueApiKeyMock.mockResolvedValueOnce({ name: 'new key', key: 'plaintext-secret-123' })
    render(MachineUserDetailPage, { props: { data: baseData() } })

    const input = screen.getByLabelText(/key name/i) as HTMLInputElement
    await fireEvent.input(input, { target: { value: '  new key  ' } })
    await fireEvent.click(screen.getByRole('button', { name: /^issue key$/i }))
    await Promise.resolve()
    await Promise.resolve()

    expect(issueApiKeyMock).toHaveBeenCalledWith(expect.any(Function), machineUserId, {
      name: 'new key',
    })
    expect(screen.getByText(/new api key — new key/i)).toBeTruthy()
    expect(screen.getByText('plaintext-secret-123')).toBeTruthy()
    expect(invalidateAllMock).toHaveBeenCalledTimes(1)
    expect((screen.getByLabelText(/key name/i) as HTMLInputElement).value).toBe('')
  })

  it('blocks issuing a key with a blank/whitespace-only name and shows a validation error, without calling the API', async () => {
    render(MachineUserDetailPage, { props: { data: baseData() } })

    const form = screen
      .getByRole('button', { name: /^issue key$/i })
      .closest('form') as HTMLFormElement
    await fireEvent.submit(form)

    expect(screen.getByText(/name is required/i)).toBeTruthy()
    expect(issueApiKeyMock).not.toHaveBeenCalled()
  })

  it('surfaces an ApiClientError message when issuing a key fails', async () => {
    issueApiKeyMock.mockRejectedValueOnce(new ApiClientError(400, null, 'Duplicate key name'))
    render(MachineUserDetailPage, { props: { data: baseData() } })

    const input = screen.getByLabelText(/key name/i) as HTMLInputElement
    await fireEvent.input(input, { target: { value: 'dup' } })
    await fireEvent.click(screen.getByRole('button', { name: /^issue key$/i }))
    await Promise.resolve()
    await Promise.resolve()

    expect(await screen.findByText('Duplicate key name')).toBeTruthy()
  })

  it('falls back to a generic error message for a non-ApiClientError issue failure', async () => {
    issueApiKeyMock.mockRejectedValueOnce(new Error('network down'))
    render(MachineUserDetailPage, { props: { data: baseData() } })

    const input = screen.getByLabelText(/key name/i) as HTMLInputElement
    await fireEvent.input(input, { target: { value: 'x' } })
    await fireEvent.click(screen.getByRole('button', { name: /^issue key$/i }))
    await Promise.resolve()
    await Promise.resolve()

    expect(await screen.findByText(/failed to issue api key/i)).toBeTruthy()
  })

  it('rotate: two-step confirm invokes rotateApiKey with the overlap value and reveals the rotated key', async () => {
    rotateApiKeyMock.mockResolvedValueOnce({ key: 'rotated-secret' })
    render(MachineUserDetailPage, {
      props: {
        data: baseData({
          apiKeys: {
            items: [
              { id: 'key-1', name: 'ci key', isRevoked: false, expiresAt: null, lastUsedAt: null },
            ],
            total: 1,
          },
        }),
      },
    })

    const overlapInput = screen.getByLabelText(/overlap/i) as HTMLInputElement
    expect(overlapInput.value).toBe('240')
    await fireEvent.input(overlapInput, { target: { value: '30' } })

    await fireEvent.click(screen.getByRole('button', { name: /^rotate$/i }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm rotate/i }))
    await Promise.resolve()
    await Promise.resolve()

    expect(rotateApiKeyMock).toHaveBeenCalledWith(expect.any(Function), machineUserId, 'key-1', 30)
    expect(screen.getByText(/ci key \(rotated\)/i)).toBeTruthy()
    expect(screen.getByText('rotated-secret')).toBeTruthy()
    expect(invalidateAllMock).toHaveBeenCalledTimes(1)
  })

  it('invalid overlap input falls back to the default 240', async () => {
    rotateApiKeyMock.mockResolvedValueOnce({ key: 'rotated-secret' })
    render(MachineUserDetailPage, {
      props: {
        data: baseData({
          apiKeys: {
            items: [
              { id: 'key-1', name: 'ci key', isRevoked: false, expiresAt: null, lastUsedAt: null },
            ],
            total: 1,
          },
        }),
      },
    })

    const overlapInput = screen.getByLabelText(/overlap/i) as HTMLInputElement
    await fireEvent.input(overlapInput, { target: { value: 'not-a-number' } })

    await fireEvent.click(screen.getByRole('button', { name: /^rotate$/i }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm rotate/i }))
    await Promise.resolve()
    await Promise.resolve()

    expect(rotateApiKeyMock).toHaveBeenCalledWith(expect.any(Function), machineUserId, 'key-1', 240)
  })

  it('surfaces an ApiClientError action error for a failed rotate', async () => {
    rotateApiKeyMock.mockRejectedValueOnce(new ApiClientError(409, null, 'Key already rotating'))
    render(MachineUserDetailPage, {
      props: {
        data: baseData({
          apiKeys: {
            items: [
              { id: 'key-1', name: 'ci key', isRevoked: false, expiresAt: null, lastUsedAt: null },
            ],
            total: 1,
          },
        }),
      },
    })

    await fireEvent.click(screen.getByRole('button', { name: /^rotate$/i }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm rotate/i }))
    await Promise.resolve()
    await Promise.resolve()

    expect(await screen.findByText('Key already rotating')).toBeTruthy()
  })

  it('falls back to a generic error message for a non-ApiClientError rotate failure', async () => {
    rotateApiKeyMock.mockRejectedValueOnce(new Error('boom'))
    render(MachineUserDetailPage, {
      props: {
        data: baseData({
          apiKeys: {
            items: [
              { id: 'key-1', name: 'ci key', isRevoked: false, expiresAt: null, lastUsedAt: null },
            ],
            total: 1,
          },
        }),
      },
    })

    await fireEvent.click(screen.getByRole('button', { name: /^rotate$/i }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm rotate/i }))
    await Promise.resolve()
    await Promise.resolve()

    expect(await screen.findByText(/failed to rotate key/i)).toBeTruthy()
  })

  it('emergency-revoke: two-step confirm invokes emergencyRevokeApiKey and reveals the new key', async () => {
    emergencyRevokeApiKeyMock.mockResolvedValueOnce({ newKey: 'emergency-secret' })
    render(MachineUserDetailPage, {
      props: {
        data: baseData({
          apiKeys: {
            items: [
              { id: 'key-1', name: 'ci key', isRevoked: false, expiresAt: null, lastUsedAt: null },
            ],
            total: 1,
          },
        }),
      },
    })

    await fireEvent.click(screen.getByRole('button', { name: /emergency revoke/i }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm emergency revoke/i }))
    await Promise.resolve()
    await Promise.resolve()

    expect(emergencyRevokeApiKeyMock).toHaveBeenCalledWith(
      expect.any(Function),
      machineUserId,
      'key-1'
    )
    expect(screen.getByText(/ci key \(emergency-revoked, new key\)/i)).toBeTruthy()
    expect(screen.getByText('emergency-secret')).toBeTruthy()
    expect(invalidateAllMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces an ApiClientError action error for a failed emergency-revoke', async () => {
    emergencyRevokeApiKeyMock.mockRejectedValueOnce(new ApiClientError(500, null, 'Vault sealed'))
    render(MachineUserDetailPage, {
      props: {
        data: baseData({
          apiKeys: {
            items: [
              { id: 'key-1', name: 'ci key', isRevoked: false, expiresAt: null, lastUsedAt: null },
            ],
            total: 1,
          },
        }),
      },
    })

    await fireEvent.click(screen.getByRole('button', { name: /emergency revoke/i }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm emergency revoke/i }))
    await Promise.resolve()
    await Promise.resolve()

    expect(await screen.findByText('Vault sealed')).toBeTruthy()
  })

  it('falls back to a generic error message for a non-ApiClientError emergency-revoke failure', async () => {
    emergencyRevokeApiKeyMock.mockRejectedValueOnce(new Error('boom'))
    render(MachineUserDetailPage, {
      props: {
        data: baseData({
          apiKeys: {
            items: [
              { id: 'key-1', name: 'ci key', isRevoked: false, expiresAt: null, lastUsedAt: null },
            ],
            total: 1,
          },
        }),
      },
    })

    await fireEvent.click(screen.getByRole('button', { name: /emergency revoke/i }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm emergency revoke/i }))
    await Promise.resolve()
    await Promise.resolve()

    expect(await screen.findByText(/failed to emergency-revoke key/i)).toBeTruthy()
  })

  it('revoke: two-step confirm invokes revokeApiKey and invalidates, with no revealed key', async () => {
    revokeApiKeyMock.mockResolvedValueOnce({ id: 'key-1', revokedAt: '2026-01-01T00:00:00.000Z' })
    render(MachineUserDetailPage, {
      props: {
        data: baseData({
          apiKeys: {
            items: [
              { id: 'key-1', name: 'ci key', isRevoked: false, expiresAt: null, lastUsedAt: null },
            ],
            total: 1,
          },
        }),
      },
    })

    await fireEvent.click(screen.getByRole('button', { name: /^revoke$/i }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm revoke/i }))
    await Promise.resolve()
    await Promise.resolve()

    expect(revokeApiKeyMock).toHaveBeenCalledWith(expect.any(Function), machineUserId, 'key-1')
    expect(invalidateAllMock).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('heading', { name: /^new api key/i })).toBeNull()
  })

  it('surfaces an ApiClientError action error for a failed revoke', async () => {
    revokeApiKeyMock.mockRejectedValueOnce(new ApiClientError(404, null, 'Key not found'))
    render(MachineUserDetailPage, {
      props: {
        data: baseData({
          apiKeys: {
            items: [
              { id: 'key-1', name: 'ci key', isRevoked: false, expiresAt: null, lastUsedAt: null },
            ],
            total: 1,
          },
        }),
      },
    })

    await fireEvent.click(screen.getByRole('button', { name: /^revoke$/i }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm revoke/i }))
    await Promise.resolve()
    await Promise.resolve()

    expect(await screen.findByText('Key not found')).toBeTruthy()
  })

  it('falls back to a generic error message for a non-ApiClientError revoke failure', async () => {
    revokeApiKeyMock.mockRejectedValueOnce(new Error('boom'))
    render(MachineUserDetailPage, {
      props: {
        data: baseData({
          apiKeys: {
            items: [
              { id: 'key-1', name: 'ci key', isRevoked: false, expiresAt: null, lastUsedAt: null },
            ],
            total: 1,
          },
        }),
      },
    })

    await fireEvent.click(screen.getByRole('button', { name: /^revoke$/i }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm revoke/i }))
    await Promise.resolve()
    await Promise.resolve()

    expect(await screen.findByText(/failed to revoke key/i)).toBeTruthy()
  })

  it('the revealed key panel Hide button clears the revealed key', async () => {
    issueApiKeyMock.mockResolvedValueOnce({ name: 'new key', key: 'plaintext-secret-123' })
    render(MachineUserDetailPage, { props: { data: baseData() } })

    const input = screen.getByLabelText(/key name/i) as HTMLInputElement
    await fireEvent.input(input, { target: { value: 'new key' } })
    await fireEvent.click(screen.getByRole('button', { name: /^issue key$/i }))
    await Promise.resolve()
    await Promise.resolve()

    expect(screen.getByText('plaintext-secret-123')).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: /^hide$/i }))
    expect(screen.queryByText('plaintext-secret-123')).toBeNull()
  })

  it('the revealed key panel Copy button writes the value to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    issueApiKeyMock.mockResolvedValueOnce({ name: 'new key', key: 'plaintext-secret-123' })
    render(MachineUserDetailPage, { props: { data: baseData() } })

    const input = screen.getByLabelText(/key name/i) as HTMLInputElement
    await fireEvent.input(input, { target: { value: 'new key' } })
    await fireEvent.click(screen.getByRole('button', { name: /^issue key$/i }))
    await Promise.resolve()
    await Promise.resolve()

    await fireEvent.click(screen.getByRole('button', { name: /^copy$/i }))
    await Promise.resolve()

    expect(writeText).toHaveBeenCalledWith('plaintext-secret-123')
  })

  it('the Copy button swallows a clipboard rejection without crashing', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.assign(navigator, { clipboard: { writeText } })
    issueApiKeyMock.mockResolvedValueOnce({ name: 'new key', key: 'plaintext-secret-123' })
    render(MachineUserDetailPage, { props: { data: baseData() } })

    const input = screen.getByLabelText(/key name/i) as HTMLInputElement
    await fireEvent.input(input, { target: { value: 'new key' } })
    await fireEvent.click(screen.getByRole('button', { name: /^issue key$/i }))
    await Promise.resolve()
    await Promise.resolve()

    await fireEvent.click(screen.getByRole('button', { name: /^copy$/i }))
    await Promise.resolve()

    expect(screen.getByText('plaintext-secret-123')).toBeTruthy()
  })

  it('deactivate: two-step confirm invokes deactivateMachineUser and invalidates', async () => {
    deactivateMachineUserMock.mockResolvedValueOnce({
      id: machineUserId,
      deactivatedAt: '2026-03-01T00:00:00.000Z',
    })
    render(MachineUserDetailPage, { props: { data: baseData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^deactivate$/i }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm deactivate/i }))
    await Promise.resolve()
    await Promise.resolve()

    expect(deactivateMachineUserMock).toHaveBeenCalledWith(expect.any(Function), machineUserId)
    expect(invalidateAllMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces an ApiClientError deactivate error', async () => {
    deactivateMachineUserMock.mockRejectedValueOnce(
      new ApiClientError(409, null, 'Already deactivated')
    )
    render(MachineUserDetailPage, { props: { data: baseData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^deactivate$/i }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm deactivate/i }))
    await Promise.resolve()
    await Promise.resolve()

    expect(await screen.findByText('Already deactivated')).toBeTruthy()
  })

  it('falls back to a generic error message for a non-ApiClientError deactivate failure', async () => {
    deactivateMachineUserMock.mockRejectedValueOnce(new Error('boom'))
    render(MachineUserDetailPage, { props: { data: baseData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^deactivate$/i }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm deactivate/i }))
    await Promise.resolve()
    await Promise.resolve()

    expect(await screen.findByText(/failed to deactivate machine user/i)).toBeTruthy()
  })

  it('links back to the machine-users list for this project', () => {
    render(MachineUserDetailPage, { props: { data: baseData() } })

    const link = screen.getByRole('link', { name: /back to machine users/i })
    expect(link.getAttribute('href')).toBe(`/projects/${projectId}/machine-users`)
  })
})
