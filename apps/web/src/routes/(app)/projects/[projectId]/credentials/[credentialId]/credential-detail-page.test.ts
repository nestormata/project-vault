import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte'
import { onboardingCopy } from '$lib/components/onboarding/onboarding-logic.js'
import { rotationCopy } from '$lib/components/rotations/rotation-copy.js'

const updateCredentialLifecycleMock = vi.hoisted(() => vi.fn())
const addCredentialDependencyMock = vi.hoisted(() => vi.fn())
const archiveCredentialDependencyMock = vi.hoisted(() => vi.fn())
const revealCredentialValueMock = vi.hoisted(() => vi.fn())
const addCredentialVersionMock = vi.hoisted(() => vi.fn())
const confirmChecklistItemMock = vi.hoisted(() => vi.fn())
const invalidateAllMock = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('$app/navigation', () => ({ invalidateAll: invalidateAllMock }))

vi.mock('$lib/api/credentials.js', async () => {
  const actual =
    await vi.importActual<typeof import('$lib/api/credentials.js')>('$lib/api/credentials.js')
  return {
    updateCredentialLifecycle: updateCredentialLifecycleMock,
    addCredentialDependency: addCredentialDependencyMock,
    archiveCredentialDependency: archiveCredentialDependencyMock,
    revealCredentialValue: revealCredentialValueMock,
    addCredentialVersion: addCredentialVersionMock,
    parseRevealedFields: actual.parseRevealedFields,
    isFieldsValue: actual.isFieldsValue,
  }
})

vi.mock('$lib/api/rotations.js', async () => {
  const actual =
    await vi.importActual<typeof import('$lib/api/rotations.js')>('$lib/api/rotations.js')
  return { ...actual, confirmChecklistItem: confirmChecklistItemMock }
})

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
    dependencies: { items: [], hasDependencies: false, hasStagedRotation: false },
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

  it('AC-20: a successful copy shows a visible, announced confirmation', async () => {
    revealCredentialValueMock.mockResolvedValue({ value: 'sk_live_abc123', versionNumber: 1 })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    render(CredentialDetailPage, { props: { data: baseData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^reveal value$/i }))
    await screen.findByText('sk_live_abc123')
    await fireEvent.click(screen.getByRole('button', { name: /^copy$/i }))

    const status = await screen.findByRole('status', { name: '' })
    expect(status.textContent).toMatch(/copied to clipboard/i)
  })

  it('AC-21: a clipboard failure while copying announces a failure message via the same status region', async () => {
    revealCredentialValueMock.mockResolvedValue({ value: 'sk_live_abc123', versionNumber: 1 })
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.assign(navigator, { clipboard: { writeText } })
    render(CredentialDetailPage, { props: { data: baseData() } })

    await fireEvent.click(screen.getByRole('button', { name: /^reveal value$/i }))
    await screen.findByText('sk_live_abc123')
    await fireEvent.click(screen.getByRole('button', { name: /^copy$/i }))

    expect(await screen.findByText(/couldn't copy/i)).toBeTruthy()
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

  it('renders a dependency link as a clickable, new-tab, noopener anchor', () => {
    render(CredentialDetailPage, {
      props: {
        data: baseData({
          dependencies: {
            items: [
              {
                id: 'dep-1',
                systemName: 'billing-worker',
                systemType: 'service',
                linkUrl: 'https://example.com/billing-worker',
                checklistStatus: null,
              },
            ],
            hasDependencies: true,
            hasStagedRotation: false,
          },
        }),
      },
    })
    const link = screen.getByRole('link', { name: 'https://example.com/billing-worker' })
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('renders no link element when linkUrl is unset', () => {
    render(CredentialDetailPage, {
      props: {
        data: baseData({
          dependencies: {
            items: [
              {
                id: 'dep-1',
                systemName: 'billing-worker',
                systemType: 'service',
                linkUrl: null,
                checklistStatus: null,
              },
            ],
            hasDependencies: true,
            hasStagedRotation: false,
          },
        }),
      },
    })
    expect(screen.queryByRole('link', { name: /billing-worker/i })).toBeNull()
  })

  it('Updated checkbox is disabled with "no rotation in progress" tooltip when hasStagedRotation is false', () => {
    render(CredentialDetailPage, {
      props: {
        data: baseData({
          dependencies: {
            items: [
              {
                id: 'dep-1',
                systemName: 'billing-worker',
                systemType: 'service',
                checklistStatus: null,
              },
            ],
            hasDependencies: true,
            hasStagedRotation: false,
          },
        }),
      },
    })
    const checkbox = screen.getByLabelText('Updated') as HTMLInputElement
    expect(checkbox.disabled).toBe(true)
    expect(checkbox.closest('label')?.getAttribute('title')).toMatch(/no rotation in progress/i)
  })

  it('Updated checkbox is disabled with "added after this rotation started" tooltip when checklistStatus is null but hasStagedRotation is true', () => {
    render(CredentialDetailPage, {
      props: {
        data: baseData({
          dependencies: {
            items: [
              { id: 'dep-1', systemName: 'delta', systemType: 'service', checklistStatus: null },
            ],
            hasDependencies: true,
            hasStagedRotation: true,
          },
        }),
      },
    })
    const checkbox = screen.getByLabelText('Updated') as HTMLInputElement
    expect(checkbox.disabled).toBe(true)
    expect(checkbox.closest('label')?.getAttribute('title')).toMatch(
      /added after this rotation started/i
    )
  })

  it('clicking the Updated checkbox confirms the checklist item and flips it to checked', async () => {
    confirmChecklistItemMock.mockResolvedValue({
      item: { status: 'confirmed', confirmedBy: 'user-1', confirmedAt: '2026-07-26T00:00:00.000Z' },
      rotationVersion: 2,
    })
    render(CredentialDetailPage, {
      props: {
        data: baseData({
          dependencies: {
            items: [
              {
                id: 'dep-1',
                systemName: 'billing-worker',
                systemType: 'service',
                checklistStatus: {
                  rotationId: 'rot-1',
                  itemId: 'item-1',
                  status: 'unconfirmed',
                  confirmedBy: null,
                  confirmedAt: null,
                },
              },
            ],
            hasDependencies: true,
            hasStagedRotation: true,
          },
        }),
      },
    })
    const checkbox = screen.getByLabelText('Updated') as HTMLInputElement
    expect(checkbox.disabled).toBe(false)
    expect(checkbox.checked).toBe(false)

    await fireEvent.click(checkbox)

    expect(confirmChecklistItemMock).toHaveBeenCalledWith(
      expect.anything(),
      projectId,
      credentialId,
      'rot-1',
      'item-1'
    )
    await vi.waitFor(() => expect(checkbox.checked).toBe(true))
  })

  it('a 409 already_confirmed reconciles the checkbox to checked instead of showing an error', async () => {
    confirmChecklistItemMock.mockRejectedValue(
      new ApiClientError(
        409,
        {
          code: 'already_confirmed',
          confirmedBy: 'other-user',
          confirmedAt: '2026-07-26T01:00:00.000Z',
        },
        'This checklist item is already confirmed.'
      )
    )
    render(CredentialDetailPage, {
      props: {
        data: baseData({
          dependencies: {
            items: [
              {
                id: 'dep-1',
                systemName: 'billing-worker',
                systemType: 'service',
                checklistStatus: {
                  rotationId: 'rot-1',
                  itemId: 'item-1',
                  status: 'unconfirmed',
                  confirmedBy: null,
                  confirmedAt: null,
                },
              },
            ],
            hasDependencies: true,
            hasStagedRotation: true,
          },
        }),
      },
    })
    const checkbox = screen.getByLabelText('Updated') as HTMLInputElement

    await fireEvent.click(checkbox)

    await vi.waitFor(() => expect(checkbox.checked).toBe(true))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a viewer sees the Updated checkbox disabled even when the item is confirmable', () => {
    render(CredentialDetailPage, {
      props: {
        data: baseData({
          orgRole: 'viewer',
          dependencies: {
            items: [
              {
                id: 'dep-1',
                systemName: 'billing-worker',
                systemType: 'service',
                checklistStatus: {
                  rotationId: 'rot-1',
                  itemId: 'item-1',
                  status: 'unconfirmed',
                  confirmedBy: null,
                  confirmedAt: null,
                },
              },
            ],
            hasDependencies: true,
            hasStagedRotation: true,
          },
        }),
      },
    })
    const checkbox = screen.getByLabelText('Updated') as HTMLInputElement
    expect(checkbox.disabled).toBe(true)
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

  // -------- Story 13.2: multi-field secrets --------

  const MULTI_FIELD_CREDENTIAL = {
    ...CREDENTIAL,
    schemaVersion: 2,
    fields: [
      { key: 'host', sensitive: false, template: 'db_connection' },
      { key: 'password', sensitive: true, template: 'db_connection' },
    ],
  }

  it('AC-7: a legacy single-field secret renders the single-value form, no field chrome', () => {
    // baseData()'s CREDENTIAL has no `fields`, so it defaults to one unnamed "value" field.
    render(CredentialDetailPage, { props: { data: baseData() } })
    expect(screen.queryByTestId('field-list')).toBeNull()
    expect(screen.getByLabelText(/new value/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /edit fields/i })).toBeNull()
  })

  it('renders the field list and an Edit fields button for a multi-field secret', () => {
    render(CredentialDetailPage, {
      props: { data: baseData({ credential: MULTI_FIELD_CREDENTIAL }) },
    })
    const list = screen.getByTestId('field-list')
    expect(list.textContent).toContain('host')
    expect(list.textContent).toContain('password')
    expect(screen.getByRole('button', { name: /edit fields/i })).toBeTruthy()
    // the single-value "Add version" form is not shown for a multi-field secret
    expect(screen.queryByLabelText(/new value/i)).toBeNull()
  })

  it('AC-4/AC-8: editing reveals current values, then saves the full field set', async () => {
    // Story 13.3 AC-5 — whole-secret reveal now returns the structured `fields[]` shape, not a
    // JSON-string-in-`value` envelope (the Story 13.2 carryover bug this story fixes).
    revealCredentialValueMock.mockResolvedValue({
      fields: [
        { key: 'host', value: 'db.example.com', sensitive: false },
        { key: 'password', value: 'old-pw', sensitive: true },
      ],
      schemaVersion: 2,
      versionNumber: 3,
      retrievedAt: '2026-07-26T00:00:00.000Z',
    })
    addCredentialVersionMock.mockResolvedValue({ credentialId, versionNumber: 4 })

    render(CredentialDetailPage, {
      props: { data: baseData({ credential: MULTI_FIELD_CREDENTIAL }) },
    })
    await fireEvent.click(screen.getByRole('button', { name: /edit fields/i }))

    // current values pre-filled (round-trip), no reveal-first gate (AC-8)
    await vi.waitFor(() =>
      expect((screen.getByLabelText('Field 1 value') as HTMLInputElement).value).toBe(
        'db.example.com'
      )
    )
    await fireEvent.input(screen.getByLabelText('Field 2 value'), {
      target: { value: 'brand-new-pw' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /save fields/i }))

    expect(addCredentialVersionMock).toHaveBeenCalledWith(
      expect.anything(),
      projectId,
      credentialId,
      expect.objectContaining({
        fields: [
          { key: 'host', value: 'db.example.com', sensitive: false },
          { key: 'password', value: 'brand-new-pw', sensitive: true },
        ],
      })
    )
  })

  it('AC-3: a 409 field_key_conflict on save shows an inline error on the colliding field', async () => {
    revealCredentialValueMock.mockResolvedValue({
      fields: [
        { key: 'host', value: 'h', sensitive: false },
        { key: 'password', value: 'p', sensitive: true },
      ],
      schemaVersion: 2,
      versionNumber: 3,
      retrievedAt: '2026-07-26T00:00:00.000Z',
    })
    addCredentialVersionMock.mockRejectedValue(
      new ApiClientError(
        409,
        { code: 'field_key_conflict' },
        'A field named "host" already exists on this secret'
      )
    )

    render(CredentialDetailPage, {
      props: { data: baseData({ credential: MULTI_FIELD_CREDENTIAL }) },
    })
    await fireEvent.click(screen.getByRole('button', { name: /edit fields/i }))
    await vi.waitFor(() => screen.getByLabelText('Field 1 value'))
    await fireEvent.click(screen.getByRole('button', { name: /save fields/i }))

    await vi.waitFor(() => expect(screen.getAllByText(/already exists/i).length).toBeGreaterThan(0))
  })

  // -------- Story 13.3: per-field reveal/mask, Reveal all --------

  const MULTI_FIELD_CREDENTIAL_WITH_VISIBLE = {
    ...MULTI_FIELD_CREDENTIAL,
    visibleFieldValues: { host: 'db.example.com' },
  }

  it('AC-1/AC-2: a non-sensitive field shows its value with no reveal click; never calls the value endpoint on load', () => {
    render(CredentialDetailPage, {
      props: { data: baseData({ credential: MULTI_FIELD_CREDENTIAL_WITH_VISIBLE }) },
    })
    expect(screen.getByTestId('field-value-host').textContent).toBe('db.example.com')
    expect(screen.getByTestId('field-masked-password').textContent).toBe('••••••••')
    expect(revealCredentialValueMock).not.toHaveBeenCalled()
  })

  it('AC-3/AC-4: reveals only the clicked sensitive field via GET .../value?field=<key>', async () => {
    revealCredentialValueMock.mockResolvedValue({
      fields: [{ key: 'password', value: 's3cret-pw', sensitive: true }],
      schemaVersion: 2,
      versionNumber: 3,
      retrievedAt: '2026-07-26T00:00:00.000Z',
    })
    render(CredentialDetailPage, {
      props: { data: baseData({ credential: MULTI_FIELD_CREDENTIAL_WITH_VISIBLE }) },
    })

    const passwordRow = screen.getByTestId('field-row-password')
    const { getByRole } = within(passwordRow)
    await fireEvent.click(getByRole('button', { name: /^reveal$/i }))

    expect(revealCredentialValueMock).toHaveBeenCalledWith(
      expect.anything(),
      projectId,
      credentialId,
      { field: 'password' }
    )
    expect((await screen.findByTestId('field-value-password')).textContent).toBe('s3cret-pw')
    // the already-visible non-sensitive field was never re-fetched
    expect(revealCredentialValueMock).toHaveBeenCalledTimes(1)
  })

  it('Subtask 3.4: Hide clears the revealed field client-side, no API call', async () => {
    revealCredentialValueMock.mockResolvedValue({
      fields: [{ key: 'password', value: 's3cret-pw', sensitive: true }],
      schemaVersion: 2,
      versionNumber: 3,
      retrievedAt: '2026-07-26T00:00:00.000Z',
    })
    render(CredentialDetailPage, {
      props: { data: baseData({ credential: MULTI_FIELD_CREDENTIAL_WITH_VISIBLE }) },
    })
    await fireEvent.click(
      within(screen.getByTestId('field-row-password')).getByRole('button', { name: /^reveal$/i })
    )
    await screen.findByTestId('field-value-password')

    await fireEvent.click(
      within(screen.getByTestId('field-row-password')).getByRole('button', { name: /^hide$/i })
    )

    expect(screen.queryByTestId('field-value-password')).toBeNull()
    expect(screen.getByTestId('field-masked-password')).toBeTruthy()
    expect(revealCredentialValueMock).toHaveBeenCalledTimes(1)
  })

  it('Subtask 3.2/AC-5: "Reveal all" renders every field in its own row, never a raw JSON blob', async () => {
    revealCredentialValueMock.mockResolvedValue({
      fields: [
        { key: 'host', value: 'db.example.com', sensitive: false },
        { key: 'password', value: 's3cret-pw', sensitive: true },
      ],
      schemaVersion: 2,
      versionNumber: 3,
      retrievedAt: '2026-07-26T00:00:00.000Z',
    })
    render(CredentialDetailPage, {
      props: { data: baseData({ credential: MULTI_FIELD_CREDENTIAL }) },
    })

    await fireEvent.click(screen.getByRole('button', { name: /reveal all/i }))

    expect((await screen.findByTestId('field-value-password')).textContent).toBe('s3cret-pw')
    expect(screen.queryByText(/^\[.*\]$/)).toBeNull()
    expect(revealCredentialValueMock).toHaveBeenCalledWith(
      expect.anything(),
      projectId,
      credentialId
    )
  })

  it('AC-7/Subtask 3.5: an unknown_field_key error surfaces inline near the affected row', async () => {
    revealCredentialValueMock.mockRejectedValue(
      new ApiClientError(400, { code: 'unknown_field_key' }, "Unknown field key: 'password'")
    )
    render(CredentialDetailPage, {
      props: { data: baseData({ credential: MULTI_FIELD_CREDENTIAL_WITH_VISIBLE }) },
    })

    await fireEvent.click(
      within(screen.getByTestId('field-row-password')).getByRole('button', { name: /^reveal$/i })
    )

    expect((await screen.findByRole('alert')).textContent).toMatch(/no longer exists/i)
  })

  it('AC-7: a legacy secret is unaffected by field-scoped reveal chrome (pixel-identical regression guard)', () => {
    render(CredentialDetailPage, { props: { data: baseData() } })
    expect(screen.queryByTestId('field-list')).toBeNull()
    expect(screen.queryByRole('button', { name: /reveal all/i })).toBeNull()
    expect(screen.getByRole('button', { name: /^reveal value$/i })).toBeTruthy()
  })
})
