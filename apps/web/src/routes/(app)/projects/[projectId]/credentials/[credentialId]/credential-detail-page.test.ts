import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { onboardingCopy } from '$lib/components/onboarding/onboarding-logic.js'
import { rotationCopy } from '$lib/components/rotations/rotation-copy.js'

const updateCredentialLifecycleMock = vi.hoisted(() => vi.fn())
const addCredentialDependencyMock = vi.hoisted(() => vi.fn())
const archiveCredentialDependencyMock = vi.hoisted(() => vi.fn())
const revealCredentialValueMock = vi.hoisted(() => vi.fn())
const addCredentialVersionMock = vi.hoisted(() => vi.fn())
const invalidateAllMock = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('$app/navigation', () => ({ invalidateAll: invalidateAllMock }))

vi.mock('$lib/api/credentials.js', () => ({
  updateCredentialLifecycle: updateCredentialLifecycleMock,
  addCredentialDependency: addCredentialDependencyMock,
  archiveCredentialDependency: archiveCredentialDependencyMock,
  revealCredentialValue: revealCredentialValueMock,
  addCredentialVersion: addCredentialVersionMock,
}))

import { ApiClientError } from '$lib/api/client.js'
import CredentialDetailPage from './+page.svelte'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const credentialId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const CREDENTIAL = {
  id: credentialId,
  name: 'Stripe Secret Key',
  description: 'Payments processor secret',
  tags: ['payments', 'prod'],
  expiresAt: '2026-12-01T00:00:00.000Z',
  rotationSchedule: '0 0 1 * *',
  cacheable: true,
  currentVersionNumber: 3,
  updatedAt: '2026-07-01T00:00:00.000Z',
}

function baseData(overrides: Record<string, unknown> = {}) {
  return {
    projectId,
    credentialId,
    orgRole: 'member',
    vaultSealed: false,
    notFound: false,
    credential: CREDENTIAL,
    dependencies: { items: [] },
    versions: [],
    rotations: [],
    activeRotationId: null,
    ...overrides,
  }
}

describe('credential detail +page.svelte', () => {
  it('shows the sealed-vault message when the vault is sealed', () => {
    render(CredentialDetailPage, { props: { data: baseData({ vaultSealed: true }) } })
    expect(screen.getByText(onboardingCopy.vaultSealedMessage)).toBeTruthy()
  })

  it('shows a not-found banner instead of the detail sections', () => {
    render(CredentialDetailPage, {
      props: { data: baseData({ credential: null, notFound: true }) },
    })
    expect(screen.getByText(/credential not found/i)).toBeTruthy()
  })

  it('renders description, tags, and current version when present', () => {
    render(CredentialDetailPage, { props: { data: baseData() } })
    expect(screen.getByText('Payments processor secret')).toBeTruthy()
    expect(screen.getByText('payments, prod')).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()
  })

  it('renders a dash for tags and no description block when absent', () => {
    render(CredentialDetailPage, {
      props: {
        data: baseData({ credential: { ...CREDENTIAL, description: null, tags: [] } }),
      },
    })
    expect(screen.getByText('—')).toBeTruthy()
  })

  it('a viewer cannot reveal values and sees no lifecycle form', () => {
    render(CredentialDetailPage, { props: { data: baseData({ orgRole: 'viewer' }) } })
    expect(screen.getByText(/revealing values requires member access/i)).toBeTruthy()
    expect(screen.queryByLabelText(/expiry date/i)).toBeNull()
  })

  it('saves lifecycle changes and updates the displayed expiry (AC-L1 override)', async () => {
    updateCredentialLifecycleMock.mockResolvedValue({
      expiresAt: '2027-01-01T00:00:00.000Z',
      rotationSchedule: '0 0 1 1 *',
    })
    render(CredentialDetailPage, { props: { data: baseData() } })
    const expiresRow = screen.getByText('Expires').closest('div')
    const beforeText = expiresRow?.textContent

    await fireEvent.click(screen.getByRole('button', { name: /save lifecycle/i }))

    expect(updateCredentialLifecycleMock).toHaveBeenCalled()
    // The rendered date is locale-formatted (shifts with the runner's timezone), so assert the
    // override changed the displayed text rather than matching a literal year substring.
    await vi.waitFor(() => {
      expect(screen.getByText('Expires').closest('div')?.textContent).not.toBe(beforeText)
    })
  })

  it('lifecycle invalid_cron error shows a field-scoped message', async () => {
    updateCredentialLifecycleMock.mockRejectedValue(
      new ApiClientError(422, { code: 'invalid_cron' }, 'Invalid cron expression')
    )
    render(CredentialDetailPage, { props: { data: baseData() } })

    await fireEvent.click(screen.getByRole('button', { name: /save lifecycle/i }))

    expect(await screen.findByText('Invalid cron expression')).toBeTruthy()
  })

  it('lifecycle 410 (archived project) shows the shared archived-project banner', async () => {
    updateCredentialLifecycleMock.mockRejectedValue(new ApiClientError(410, {}, 'gone'))
    render(CredentialDetailPage, { props: { data: baseData() } })

    await fireEvent.click(screen.getByRole('button', { name: /save lifecycle/i }))

    expect(
      await screen.findByText(/this project is archived — unarchive it to make changes/i)
    ).toBeTruthy()
  })

  it('lifecycle failure with a real Error surfaces its exact message', async () => {
    updateCredentialLifecycleMock.mockRejectedValueOnce(new Error('network down'))
    render(CredentialDetailPage, { props: { data: baseData() } })

    await fireEvent.click(screen.getByRole('button', { name: /save lifecycle/i }))

    expect(await screen.findByText('network down')).toBeTruthy()
  })

  it('lifecycle failure with a non-Error thrown value shows the generic lifecycle-error message', async () => {
    updateCredentialLifecycleMock.mockRejectedValueOnce('plain string rejection')
    render(CredentialDetailPage, { props: { data: baseData() } })

    await fireEvent.click(screen.getByRole('button', { name: /save lifecycle/i }))

    expect(await screen.findByText(/^could not update lifecycle fields\.$/i)).toBeTruthy()
  })

  it('reveals a value, shows the version, then hides it again', async () => {
    revealCredentialValueMock.mockResolvedValue({ value: 'sk_live_abc123', versionNumber: 3 })
    render(CredentialDetailPage, { props: { data: baseData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^reveal value$/i }))

    expect(await screen.findByText('sk_live_abc123')).toBeTruthy()
    expect(screen.getByText('Version 3')).toBeTruthy()

    await fireEvent.click(screen.getByRole('button', { name: /^hide$/i }))
    expect(screen.queryByText('sk_live_abc123')).toBeNull()
  })

  it('reveal: insufficient_project_role shows the role-specific remediation message', async () => {
    revealCredentialValueMock.mockRejectedValue(
      new ApiClientError(403, { code: 'insufficient_project_role' }, 'denied')
    )
    render(CredentialDetailPage, { props: { data: baseData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^reveal value$/i }))

    expect(await screen.findByText(/does not permit revealing credential values/i)).toBeTruthy()
  })

  it('reveal: a plain 403 shows the generic permission message', async () => {
    revealCredentialValueMock.mockRejectedValue(new ApiClientError(403, {}, 'denied'))
    render(CredentialDetailPage, { props: { data: baseData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^reveal value$/i }))

    expect(
      await screen.findByText(/^you do not have permission to reveal credential values\.$/i)
    ).toBeTruthy()
  })

  it('reveal: a real Error failure surfaces its exact message', async () => {
    revealCredentialValueMock.mockRejectedValueOnce(new Error('network down'))
    render(CredentialDetailPage, { props: { data: baseData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^reveal value$/i }))

    expect(await screen.findByText('network down')).toBeTruthy()
  })

  it('reveal: a non-Error thrown value shows the generic reveal-error message', async () => {
    revealCredentialValueMock.mockRejectedValueOnce('plain string rejection')
    render(CredentialDetailPage, { props: { data: baseData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^reveal value$/i }))

    expect(await screen.findByText(/^could not reveal value\.$/i)).toBeTruthy()
  })

  it('copies the revealed value to the clipboard', async () => {
    revealCredentialValueMock.mockResolvedValue({ value: 'sk_live_abc123', versionNumber: 1 })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    render(CredentialDetailPage, { props: { data: baseData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^reveal value$/i }))
    await screen.findByText('sk_live_abc123')
    await fireEvent.click(screen.getByRole('button', { name: /^copy$/i }))

    expect(writeText).toHaveBeenCalledWith('sk_live_abc123')
  })

  it('a clipboard failure while copying does not throw or crash the page', async () => {
    revealCredentialValueMock.mockResolvedValue({ value: 'sk_live_abc123', versionNumber: 1 })
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.assign(navigator, { clipboard: { writeText } })
    render(CredentialDetailPage, { props: { data: baseData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^reveal value$/i }))
    await screen.findByText('sk_live_abc123')
    await fireEvent.click(screen.getByRole('button', { name: /^copy$/i }))

    expect(screen.getByText('sk_live_abc123')).toBeTruthy()
  })

  it('adding a new version requires a non-blank value, no API call otherwise', async () => {
    render(CredentialDetailPage, { props: { data: baseData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^add version$/i }))

    expect(screen.getByText('Value is required')).toBeTruthy()
    expect(addCredentialVersionMock).not.toHaveBeenCalled()
  })

  it('adding a new version succeeds and re-runs the loader via invalidateAll', async () => {
    addCredentialVersionMock.mockResolvedValue({ versionNumber: 4 })
    render(CredentialDetailPage, { props: { data: baseData() } })

    await fireEvent.input(screen.getByLabelText(/new value/i), { target: { value: 'sk_new' } })
    await fireEvent.click(screen.getByRole('button', { name: /^add version$/i }))

    expect(addCredentialVersionMock).toHaveBeenCalledWith(
      expect.anything(),
      projectId,
      credentialId,
      { value: 'sk_new' }
    )
    await vi.waitFor(() => expect(invalidateAllMock).toHaveBeenCalled())
  })

  it('add version: 410 shows the archived-project banner', async () => {
    addCredentialVersionMock.mockRejectedValue(new ApiClientError(410, {}, 'gone'))
    render(CredentialDetailPage, { props: { data: baseData() } })

    await fireEvent.input(screen.getByLabelText(/new value/i), { target: { value: 'sk_new' } })
    await fireEvent.click(screen.getByRole('button', { name: /^add version$/i }))

    expect(await screen.findByText(/this project is archived/i)).toBeTruthy()
  })

  it('add version: version_conflict shows a refresh-and-retry message', async () => {
    addCredentialVersionMock.mockRejectedValue(
      new ApiClientError(409, { code: 'version_conflict' }, 'conflict')
    )
    render(CredentialDetailPage, { props: { data: baseData() } })

    await fireEvent.input(screen.getByLabelText(/new value/i), { target: { value: 'sk_new' } })
    await fireEvent.click(screen.getByRole('button', { name: /^add version$/i }))

    expect(await screen.findByText(/refresh and try again/i)).toBeTruthy()
  })

  it('shows an honest empty state when there is no version history, and rows with a Current badge otherwise', () => {
    render(CredentialDetailPage, { props: { data: baseData() } })
    expect(screen.getByText(/no version history available/i)).toBeTruthy()

    cleanup()
    render(CredentialDetailPage, {
      props: {
        data: baseData({
          versions: [
            { versionNumber: 2, createdAt: '2026-06-01T00:00:00.000Z', isCurrent: false },
            { versionNumber: 3, createdAt: '2026-07-01T00:00:00.000Z', isCurrent: true },
          ],
        }),
      },
    })
    expect(screen.getByText('Current')).toBeTruthy()
    expect(screen.getByText('Version 2')).toBeTruthy()
  })

  it('adds a dependent system and it appears in the list immediately', async () => {
    addCredentialDependencyMock.mockResolvedValue({
      id: 'dep-1',
      systemName: 'billing-worker',
      systemType: 'service',
      notes: null,
    })
    render(CredentialDetailPage, { props: { data: baseData() } })

    await fireEvent.input(screen.getByLabelText(/system name/i), {
      target: { value: 'billing-worker' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /^add dependent system$/i }))

    expect(await screen.findByText(/billing-worker \(service\)/)).toBeTruthy()
  })

  it('add dependency: too_many_dependencies shows its own error, not the generic one', async () => {
    addCredentialDependencyMock.mockRejectedValue(
      new ApiClientError(422, { code: 'too_many_dependencies' }, 'Too many dependent systems')
    )
    render(CredentialDetailPage, { props: { data: baseData() } })

    await fireEvent.input(screen.getByLabelText(/system name/i), { target: { value: 'x' } })
    await fireEvent.click(screen.getByRole('button', { name: /^add dependent system$/i }))

    expect(await screen.findByText('Too many dependent systems')).toBeTruthy()
  })

  it('add dependency: 410 shows the archived-project banner', async () => {
    addCredentialDependencyMock.mockRejectedValue(new ApiClientError(410, {}, 'gone'))
    render(CredentialDetailPage, { props: { data: baseData() } })

    await fireEvent.input(screen.getByLabelText(/system name/i), { target: { value: 'x' } })
    await fireEvent.click(screen.getByRole('button', { name: /^add dependent system$/i }))

    expect(await screen.findByText(/this project is archived/i)).toBeTruthy()
  })

  it('archives a dependency and it is removed from the list', async () => {
    archiveCredentialDependencyMock.mockResolvedValue(undefined)
    render(CredentialDetailPage, {
      props: {
        data: baseData({
          dependencies: {
            items: [{ id: 'dep-1', systemName: 'billing-worker', systemType: 'service' }],
          },
        }),
      },
    })

    await fireEvent.click(screen.getByRole('button', { name: /^archive$/i }))

    await vi.waitFor(() => expect(screen.queryByText(/billing-worker/)).toBeNull())
  })

  it('archiving a dependency that fails with 410 shows the archived-project banner', async () => {
    archiveCredentialDependencyMock.mockRejectedValue(new ApiClientError(410, {}, 'gone'))
    render(CredentialDetailPage, {
      props: {
        data: baseData({
          dependencies: {
            items: [{ id: 'dep-1', systemName: 'billing-worker', systemType: 'service' }],
          },
        }),
      },
    })

    await fireEvent.click(screen.getByRole('button', { name: /^archive$/i }))

    expect(await screen.findByText(/this project is archived/i)).toBeTruthy()
  })

  it('an active rotation shows a link to view it', () => {
    render(CredentialDetailPage, {
      props: { data: baseData({ activeRotationId: 'rot-1', orgRole: 'admin' }) },
    })
    expect(screen.getByRole('link', { name: /view active rotation/i })).toBeTruthy()
  })

  it('an admin with no active rotation sees a Start rotation link', () => {
    render(CredentialDetailPage, { props: { data: baseData({ orgRole: 'admin' }) } })
    expect(screen.getByRole('link', { name: /start rotation/i })).toBeTruthy()
  })

  it('a non-admin with no active rotation sees the admin-required copy instead of a link', () => {
    render(CredentialDetailPage, { props: { data: baseData({ orgRole: 'member' }) } })
    expect(screen.getByText(rotationCopy.startRotationRequiresAdmin)).toBeTruthy()
    expect(screen.queryByRole('link', { name: /start rotation/i })).toBeNull()
  })

  it('shows an honest empty state for rotation history, and rows otherwise', () => {
    render(CredentialDetailPage, { props: { data: baseData() } })
    expect(screen.getByText(rotationCopy.noRotationsYet)).toBeTruthy()

    cleanup()
    render(CredentialDetailPage, {
      props: {
        data: baseData({
          rotations: [
            {
              id: 'rot-1',
              status: 'completed',
              initiatedAt: '2026-06-01T00:00:00.000Z',
              completedAt: '2026-06-02T00:00:00.000Z',
            },
          ],
        }),
      },
    })
    expect(screen.getByText('completed')).toBeTruthy()
  })
})
