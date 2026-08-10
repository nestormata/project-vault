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
const listCredentialDependenciesMock = vi.hoisted(() => vi.fn())
const createCredentialShareMock = vi.hoisted(() => vi.fn())
const createExternalCredentialShareMock = vi.hoisted(() => vi.fn())
const revokeCredentialShareMock = vi.hoisted(() => vi.fn())
const dismissRotationRecommendedNudgeMock = vi.hoisted(() => vi.fn())
const invalidateAllMock = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('$app/navigation', () => ({ invalidateAll: invalidateAllMock }))

vi.mock('$lib/api/credential-shares.js', () => ({
  createCredentialShare: createCredentialShareMock,
  createExternalCredentialShare: createExternalCredentialShareMock,
  revokeCredentialShare: revokeCredentialShareMock,
  dismissRotationRecommendedNudge: dismissRotationRecommendedNudgeMock,
}))

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
    listCredentialDependencies: listCredentialDependenciesMock,
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
    origin: 'https://vault.example.com',
    vaultSealed: false,
    notFound: false,
    credential: CREDENTIAL,
    dependencies: { items: [], hasDependencies: false, hasStagedRotation: false },
    versions: [],
    rotations: [],
    activeRotationId: null,
    shares: [],
    orgMembers: [{ userId: 'recipient-1', email: 'riley@example.com', displayName: 'Riley' }],
    ...overrides,
  }
}

describe('credential detail +page.svelte', () => {
  it('renders accessible, always-visible contextual help for lifecycle and dependency fields', async () => {
    render(CredentialDetailPage, {
      props: {
        data: baseData({
          credential: {
            ...CREDENTIAL,
            fields: [
              { key: 'username', sensitive: false },
              { key: 'password', sensitive: true },
            ],
          },
        }),
      },
    })

    const rotationSchedule = screen.getByLabelText(/rotation schedule/i)
    expect(rotationSchedule.getAttribute('aria-describedby')).toBe(
      'lifecycle-rotation-schedule-help'
    )
    expect(screen.getByText(/standard 5-field cron syntax/i)).toBeTruthy()
    expect(screen.getByText(/every 1st day of the month/i)).toBeTruthy()
    expect(screen.getByText(/next run \(utc\):/i)).toBeTruthy()

    const cronHelpButton = screen.getByRole('button', { name: /show cron field help/i })
    await fireEvent.click(cronHelpButton)
    expect(screen.getByRole('dialog', { name: /cron schedule fields/i })).toBeTruthy()

    const cacheable = screen.getByLabelText(/cacheable by offline agents/i)
    expect(cacheable.getAttribute('aria-describedby')).toBe('lifecycle-cacheable-help')
    expect(screen.getByText(/may cache and reuse this credential locally/i)).toBeTruthy()

    expect(screen.getByText(/external systems that use this credential/i)).toBeTruthy()

    const shareFieldCheckbox = screen.getByRole('checkbox', { name: /username/i })
    expect(shareFieldCheckbox.getAttribute('aria-describedby')).toBe('share-attribute-keys-help')

    expect(screen.getByLabelText(/system type/i).getAttribute('aria-describedby')).toBe(
      'dependency-system-type-help'
    )
    expect(screen.getByLabelText(/scope to field/i).getAttribute('aria-describedby')).toBe(
      'dependency-field-key-help'
    )
    expect(screen.getByLabelText(/link \(optional\)/i).getAttribute('aria-describedby')).toContain(
      'dependency-link-url-help'
    )
  })

  it('explains that the Expiry date and Rotation schedule fields are independent of each other', () => {
    render(CredentialDetailPage, { props: { data: baseData() } })

    const expiryInput = screen.getByLabelText(/expiry date/i)
    expect(expiryInput.getAttribute('aria-describedby')).toBe('lifecycle-expires-help')
    const expiryHelp = document.getElementById('lifecycle-expires-help')
    expect(expiryHelp?.textContent).toBeTruthy()
    expect(expiryHelp?.textContent).toMatch(/rotation/i)
    expect(expiryHelp?.textContent).not.toBe(
      'Choose the date that controls this setting or filter.'
    )

    expect(
      screen.getByText(/never changes the expiry date|expiry date field's value/i)
    ).toBeTruthy()
  })

  it('does not preview a cron schedule the lifecycle API will reject as too frequent', () => {
    render(CredentialDetailPage, {
      props: { data: baseData({ credential: { ...CREDENTIAL, rotationSchedule: '* * * * *' } }) },
    })

    expect(screen.queryByText(/next run \(utc\):/i)).toBeNull()
  })

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

  it('copies a legacy value without revealing it or storing plaintext in rendered state', async () => {
    revealCredentialValueMock.mockResolvedValue({ value: 'sk_live_copy_only', versionNumber: 3 })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    render(CredentialDetailPage, { props: { data: baseData() } })

    const copyButton = screen.getByRole('button', {
      name: /copy credential value without revealing/i,
    })
    const guidanceId = copyButton.getAttribute('aria-describedby')
    expect(guidanceId).toBeTruthy()
    expect(document.getElementById(guidanceId ?? '')?.textContent).toMatch(
      /copies the value to your clipboard without showing it/i
    )

    await fireEvent.click(copyButton)

    expect(revealCredentialValueMock).toHaveBeenCalledWith(
      expect.anything(),
      projectId,
      credentialId
    )
    expect(writeText).toHaveBeenCalledWith('sk_live_copy_only')
    expect(screen.queryByText('sk_live_copy_only')).toBeNull()
    expect(screen.queryByRole('button', { name: /^hide$/i })).toBeNull()
    expect((await screen.findByRole('status')).textContent).toMatch(/copied to clipboard/i)
    expect(screen.getByRole('status').textContent).not.toContain('sk_live_copy_only')
  })

  it('copies one multi-field value through the scoped reveal path while the field stays masked', async () => {
    revealCredentialValueMock.mockResolvedValue({
      fields: [{ key: 'password', value: 'field_copy_only', sensitive: true }],
      schemaVersion: 2,
      versionNumber: 3,
      retrievedAt: '2026-07-26T00:00:00.000Z',
    })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    render(CredentialDetailPage, {
      props: { data: baseData({ credential: MULTI_FIELD_CREDENTIAL_WITH_VISIBLE }) },
    })

    const passwordRow = screen.getByTestId('field-row-password')
    const copyButton = within(passwordRow).getByRole('button', {
      name: /copy password without revealing/i,
    })
    const guidanceId = copyButton.getAttribute('aria-describedby')
    expect(guidanceId).toBeTruthy()
    expect(document.getElementById(guidanceId ?? '')?.textContent).toMatch(
      /copies only the password field .*without showing it/i
    )

    await fireEvent.click(copyButton)

    expect(revealCredentialValueMock).toHaveBeenCalledWith(
      expect.anything(),
      projectId,
      credentialId,
      { field: 'password' }
    )
    expect(writeText).toHaveBeenCalledWith('field_copy_only')
    expect(screen.getByTestId('field-masked-password')).toBeTruthy()
    expect(screen.getByTestId('field-value-host').textContent).toContain('db.example.com')
    expect(screen.queryByText('field_copy_only')).toBeNull()
    expect(screen.getByRole('status').textContent).not.toContain('field_copy_only')
    expect((await screen.findByRole('status')).textContent).toMatch(/copied password to clipboard/i)
  })

  it('keeps a failed copy actionable and announces only a localized generic failure', async () => {
    revealCredentialValueMock.mockRejectedValue(new Error('secret must not escape'))
    const writeText = vi.fn()
    Object.assign(navigator, { clipboard: { writeText } })
    render(CredentialDetailPage, { props: { data: baseData() } })

    const copyButton = screen.getByRole('button', {
      name: /copy credential value without revealing/i,
    })
    await fireEvent.click(copyButton)

    const status = await screen.findByRole('status')
    expect(status.textContent).toMatch(/could not copy the credential value/i)
    expect(status.textContent).not.toContain('secret must not escape')
    expect((copyButton as HTMLButtonElement).disabled).toBe(false)
    expect(writeText).not.toHaveBeenCalled()
    expect(screen.queryByText('secret must not escape')).toBeNull()
  })

  it('keeps plaintext out of the DOM when the copy-only clipboard write fails', async () => {
    revealCredentialValueMock.mockResolvedValue({
      value: 'clipboard_secret_only',
      versionNumber: 3,
    })
    const writeText = vi.fn().mockRejectedValue(new Error('clipboard denied'))
    Object.assign(navigator, { clipboard: { writeText } })
    render(CredentialDetailPage, { props: { data: baseData() } })

    const copyButton = screen.getByRole('button', {
      name: /copy credential value without revealing/i,
    })
    await fireEvent.click(copyButton)

    const status = await screen.findByRole('status')
    expect(status.textContent).toMatch(/could not copy the credential value/i)
    expect(status.textContent).not.toContain('clipboard_secret_only')
    expect(screen.queryByText('clipboard_secret_only')).toBeNull()
    expect((copyButton as HTMLButtonElement).disabled).toBe(false)
  })

  it('prevents duplicate clicks during a copy and restores the control afterward', async () => {
    let resolveReveal!: (value: { value: string; versionNumber: number }) => void
    revealCredentialValueMock.mockReturnValue(
      new Promise((resolve) => {
        resolveReveal = resolve
      })
    )
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    render(CredentialDetailPage, { props: { data: baseData() } })

    const copyButton = screen.getByRole('button', {
      name: /copy credential value without revealing/i,
    })
    await fireEvent.click(copyButton)
    expect((copyButton as HTMLButtonElement).disabled).toBe(true)
    await fireEvent.click(copyButton)
    expect(revealCredentialValueMock).toHaveBeenCalledTimes(1)

    resolveReveal({ value: 'concurrent_copy_only', versionNumber: 3 })
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('concurrent_copy_only'))
    expect((copyButton as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByText('concurrent_copy_only')).toBeNull()
  })

  it('copies field keys that inherit object properties without silently no-oping', async () => {
    revealCredentialValueMock.mockResolvedValue({
      fields: [{ key: 'toString', value: 'special-field-copy', sensitive: true }],
      schemaVersion: 2,
      versionNumber: 3,
      retrievedAt: '2026-07-26T00:00:00.000Z',
    })
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    render(CredentialDetailPage, {
      props: {
        data: baseData({
          credential: {
            ...CREDENTIAL,
            schemaVersion: 2,
            fields: [{ key: 'toString', sensitive: true }],
          },
        }),
      },
    })

    await fireEvent.click(
      within(screen.getByTestId('field-row-toString')).getByRole('button', {
        name: /copy tostring without revealing/i,
      })
    )

    expect(revealCredentialValueMock).toHaveBeenCalledWith(
      expect.anything(),
      projectId,
      credentialId,
      { field: 'toString' }
    )
    expect(writeText).toHaveBeenCalledWith('special-field-copy')
  })

  it('keeps copy guidance accessible for field keys containing spaces', () => {
    render(CredentialDetailPage, {
      props: {
        data: baseData({
          credential: {
            ...CREDENTIAL,
            schemaVersion: 2,
            fields: [{ key: 'api key', sensitive: true }],
          },
        }),
      },
    })

    const copyButton = within(screen.getByTestId('field-row-api key')).getByRole('button', {
      name: /copy api key without revealing/i,
    })
    const guidanceId = copyButton.getAttribute('aria-describedby')
    expect(guidanceId).toBe('credential-copy-help-api%20key')
    expect(document.getElementById(guidanceId ?? '')).toBeTruthy()
  })

  it('hides copy and reveal controls from project viewers', () => {
    render(CredentialDetailPage, {
      props: {
        data: baseData({
          orgRole: 'member',
          project: { role: 'viewer' },
          credential: MULTI_FIELD_CREDENTIAL_WITH_VISIBLE,
        }),
      },
    })

    expect(screen.queryByRole('button', { name: /copy .* without revealing/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^reveal( all| value)?$/i })).toBeNull()
  })

  it('does not render copy-without-reveal controls for viewers', () => {
    render(CredentialDetailPage, {
      props: {
        data: baseData({
          orgRole: 'viewer',
          credential: MULTI_FIELD_CREDENTIAL_WITH_VISIBLE,
        }),
      },
    })

    expect(screen.queryByRole('button', { name: /copy .* without revealing/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^reveal( all| value)?$/i })).toBeNull()
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

  // Story 18.7 AC-5/6/8: the add-form is collapsed by default behind a native
  // <details>/<summary> disclosure, so it doesn't clutter the page until Morgan needs it.
  describe('Story 18.7: "Add dependent system" disclosure', () => {
    function getDependencyFormDetails(): HTMLDetailsElement {
      const summary = screen.getByText(/^add dependent system$/i, { selector: 'summary' })
      const details = summary.closest('details')
      if (!details) throw new Error('expected a <details> ancestor for the add-form summary')
      return details
    }

    it('is collapsed by default', () => {
      render(CredentialDetailPage, { props: { data: baseData() } })
      expect(getDependencyFormDetails().open).toBe(false)
    })

    it('expands to show the form fields when the summary is activated', async () => {
      render(CredentialDetailPage, { props: { data: baseData() } })
      const details = getDependencyFormDetails()

      await fireEvent.click(screen.getByText(/^add dependent system$/i, { selector: 'summary' }))

      expect(details.open).toBe(true)
      expect(screen.getByLabelText(/system name/i)).toBeTruthy()
    })
  })

  it('adds a dependent system and it appears in the list immediately', async () => {
    addCredentialDependencyMock.mockResolvedValue({
      id: 'dep-1',
      systemName: 'billing-worker',
      systemType: 'service',
      notes: null,
    })
    render(CredentialDetailPage, { props: { data: baseData() } })
    await fireEvent.click(screen.getByText(/^add dependent system$/i, { selector: 'summary' }))

    await fireEvent.input(screen.getByLabelText(/system name/i), {
      target: { value: 'billing-worker' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /^add dependent system$/i }))

    expect(await screen.findByText(/billing-worker \(service\)/)).toBeTruthy()
  })

  it('shows an inline error and makes no request when the dependent-system name is whitespace', async () => {
    render(CredentialDetailPage, { props: { data: baseData() } })
    await fireEvent.click(screen.getByText(/^add dependent system$/i, { selector: 'summary' }))

    const nameInput = screen.getByLabelText(/system name/i) as HTMLInputElement
    await fireEvent.input(nameInput, { target: { value: ' \t\n ' } })
    await fireEvent.click(screen.getByRole('button', { name: /^add dependent system$/i }))

    expect(addCredentialDependencyMock).not.toHaveBeenCalled()
    expect((await screen.findByRole('alert')).textContent).toContain('System name is required.')
    expect(nameInput.getAttribute('aria-describedby')).toContain('dependency-system-name-error')
  })

  it('clears the local error on a corrected retry and submits the trimmed name once', async () => {
    addCredentialDependencyMock.mockResolvedValue({
      id: 'dep-2',
      systemName: 'billing-worker',
      systemType: 'other',
      notes: null,
    })
    render(CredentialDetailPage, { props: { data: baseData() } })
    await fireEvent.click(screen.getByText(/^add dependent system$/i, { selector: 'summary' }))

    const nameInput = screen.getByLabelText(/system name/i) as HTMLInputElement
    await fireEvent.input(nameInput, { target: { value: '   ' } })
    await fireEvent.click(screen.getByRole('button', { name: /^add dependent system$/i }))
    expect(await screen.findByText('System name is required.')).toBeTruthy()

    await fireEvent.input(nameInput, { target: { value: '  billing-worker  ' } })
    await fireEvent.click(screen.getByRole('button', { name: /^add dependent system$/i }))

    await vi.waitFor(() =>
      expect(addCredentialDependencyMock).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        credentialId,
        { systemName: 'billing-worker', systemType: 'other' }
      )
    )
    expect(screen.queryByText('System name is required.')).toBeNull()
  })

  it('add dependency: too_many_dependencies shows its own error, not the generic one', async () => {
    addCredentialDependencyMock.mockRejectedValue(
      new ApiClientError(422, { code: 'too_many_dependencies' }, 'Too many dependent systems')
    )
    render(CredentialDetailPage, { props: { data: baseData() } })
    await fireEvent.click(screen.getByText(/^add dependent system$/i, { selector: 'summary' }))

    await fireEvent.input(screen.getByLabelText(/system name/i), { target: { value: 'x' } })
    await fireEvent.click(screen.getByRole('button', { name: /^add dependent system$/i }))

    expect(await screen.findByText('Too many dependent systems')).toBeTruthy()
  })

  it('add dependency: 410 shows the archived-project banner', async () => {
    addCredentialDependencyMock.mockRejectedValue(new ApiClientError(410, {}, 'gone'))
    render(CredentialDetailPage, { props: { data: baseData() } })
    await fireEvent.click(screen.getByText(/^add dependent system$/i, { selector: 'summary' }))

    await fireEvent.input(screen.getByLabelText(/system name/i), { target: { value: 'x' } })
    await fireEvent.click(screen.getByRole('button', { name: /^add dependent system$/i }))

    expect(await screen.findByText(/this project is archived/i)).toBeTruthy()
  })

  // Story 13.5 AC-6: field-scope selector for multi-field credentials + scope badge.
  describe('Story 13.5 AC-6: dependency field-scope selector and badge', () => {
    const MULTI_FIELD_FOR_DEPS = {
      ...CREDENTIAL,
      schemaVersion: 2,
      fields: [
        { key: 'host', sensitive: false, template: 'db_connection' },
        { key: 'password', sensitive: true, template: 'db_connection' },
      ],
    }

    it('renders the scope dropdown for a multi-field credential and wires fieldKey into the request', async () => {
      addCredentialDependencyMock.mockResolvedValue({
        id: 'dep-1',
        systemName: 'backup-script',
        systemType: 'service',
        notes: null,
        fieldKey: 'password',
      })
      render(CredentialDetailPage, {
        props: { data: baseData({ credential: MULTI_FIELD_FOR_DEPS }) },
      })
      await fireEvent.click(screen.getByText(/^add dependent system$/i, { selector: 'summary' }))

      const select = screen.getByLabelText(/scope to field/i) as HTMLSelectElement
      expect(select).toBeTruthy()

      await fireEvent.input(screen.getByLabelText(/system name/i), {
        target: { value: 'backup-script' },
      })
      await fireEvent.change(select, { target: { value: 'password' } })
      await fireEvent.click(screen.getByRole('button', { name: /^add dependent system$/i }))

      await vi.waitFor(() =>
        expect(addCredentialDependencyMock).toHaveBeenCalledWith(
          expect.anything(),
          projectId,
          credentialId,
          expect.objectContaining({ fieldKey: 'password' })
        )
      )
    })

    it('does not render the scope dropdown for a legacy/single-field credential', () => {
      render(CredentialDetailPage, { props: { data: baseData() } })
      expect(screen.queryByLabelText(/scope to field/i)).toBeNull()
    })

    it('shows a "Scoped to" badge for a dependency with a non-null fieldKey, and no badge otherwise', () => {
      render(CredentialDetailPage, {
        props: {
          data: baseData({
            dependencies: {
              items: [
                {
                  id: 'dep-1',
                  systemName: 'backup-script',
                  systemType: 'service',
                  fieldKey: 'password',
                  checklistStatus: null,
                },
                {
                  id: 'dep-2',
                  systemName: 'ci-pipeline',
                  systemType: 'ci_pipeline',
                  fieldKey: null,
                  checklistStatus: null,
                },
              ],
              hasDependencies: true,
              hasStagedRotation: false,
            },
          }),
        },
      })

      expect(screen.getByText('Scoped to: password')).toBeTruthy()
      expect(screen.queryByText(/Scoped to: ci-pipeline/)).toBeNull()
    })
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

  // Story 18.7 AC-2/3: the "Updated" checkbox reuses Story 2.10's rotation-checklist
  // confirmation control — it is only ever meaningful during an active (staged) rotation for a
  // dependency the checklist actually tracks. Outside that context it has nothing to do, so it
  // is hidden entirely rather than shown permanently disabled with an unreadable tooltip.
  it('Updated checkbox is hidden (not shown-disabled) when there is no staged rotation', () => {
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
    expect(screen.getByText(/billing-worker \(service\)/)).toBeTruthy()
    expect(screen.queryByLabelText('Updated')).toBeNull()
  })

  it('Updated checkbox is hidden when the dependency was added after the staged rotation started (no checklist entry)', () => {
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
    expect(screen.getByText(/delta \(service\)/)).toBeTruthy()
    expect(screen.queryByLabelText('Updated')).toBeNull()
  })

  it('reactivity: the checkbox appears without a reload once a poll observes a newly-staged rotation', async () => {
    vi.useFakeTimers()
    listCredentialDependenciesMock.mockResolvedValue({
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
                checklistStatus: null,
              },
            ],
            hasDependencies: true,
            hasStagedRotation: false,
          },
        }),
      },
    })
    expect(screen.queryByLabelText('Updated')).toBeNull()

    await vi.advanceTimersByTimeAsync(15000)

    expect(listCredentialDependenciesMock).toHaveBeenCalledWith(
      expect.anything(),
      projectId,
      credentialId
    )
    const checkbox = screen.getByLabelText('Updated') as HTMLInputElement
    expect(checkbox.disabled).toBe(false)
  })

  it('reactivity: the checkbox disappears without a reload once a poll observes the rotation ending', async () => {
    vi.useFakeTimers()
    listCredentialDependenciesMock.mockResolvedValue({
      items: [
        { id: 'dep-1', systemName: 'billing-worker', systemType: 'service', checklistStatus: null },
      ],
      hasDependencies: true,
      hasStagedRotation: false,
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
    expect(screen.getByLabelText('Updated')).toBeTruthy()

    await vi.advanceTimersByTimeAsync(15000)

    expect(screen.queryByLabelText('Updated')).toBeNull()
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

  describe('Story 17.1: Shares tab', () => {
    it('shows an honest empty state when there are no shares', () => {
      render(CredentialDetailPage, { props: { data: baseData() } })
      expect(screen.getByText(/no shares yet for this credential/i)).toBeTruthy()
    })

    it('creates a share and shows the one-time token banner', async () => {
      createCredentialShareMock.mockResolvedValue({
        id: 'share-1',
        credentialId,
        fieldKey: null,
        sharedBy: 'sharer-1',
        recipientUserId: 'recipient-1',
        singleUse: true,
        createdAt: '2026-07-28T00:00:00.000Z',
        expiresAt: '2026-07-29T00:00:00.000Z',
        revokedAt: null,
        firstViewedAt: null,
        viewCount: 0,
        status: 'active',
        token: 'raw-one-time-token',
      })
      render(CredentialDetailPage, { props: { data: baseData() } })

      await fireEvent.change(screen.getByLabelText(/recipient/i), {
        target: { value: 'recipient-1' },
      })
      // The default fixture is a legacy single-value credential — its one implicit field is
      // always `sensitive: true`, so it must be explicitly checked or the share would resolve to
      // an empty field set and the create-share guard blocks the submission (see the AC-9 bugfix
      // test above).
      await fireEvent.click(screen.getByRole('checkbox', { name: /value/i }))
      await fireEvent.click(screen.getByRole('button', { name: /create share link/i }))

      expect(createCredentialShareMock).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        credentialId,
        expect.objectContaining({ recipientUserId: 'recipient-1', singleUse: true })
      )
      expect(await screen.findByText(/raw-one-time-token/)).toBeTruthy()
    })

    // Story 20.5 AC-9: sensitive fields render unchecked-by-default with a visible
    // "excluded by default" badge (not hidden entirely); non-sensitive fields render checked.
    // Leaving every field at its default sends `attributeKeys: null` (whole-resource,
    // sensitivity-default-exclusion applies at serialization time) rather than an explicit list.
    it('Story 20.5 AC-9: renders a checkbox per field, sensitive fields unchecked with a visible badge, non-sensitive checked', () => {
      render(CredentialDetailPage, {
        props: {
          data: baseData({
            credential: {
              ...CREDENTIAL,
              fields: [
                { key: 'username', sensitive: false },
                { key: 'password', sensitive: true },
              ],
            },
          }),
        },
      })

      const usernameCheckbox = screen.getByRole('checkbox', { name: /username/i })
      const passwordCheckbox = screen.getByRole('checkbox', { name: /password/i })
      expect((usernameCheckbox as HTMLInputElement).checked).toBe(true)
      expect((passwordCheckbox as HTMLInputElement).checked).toBe(false)
      expect(screen.getByText(/excluded by default/i)).toBeTruthy()
    })

    it('Story 20.5 AC-9: leaving every field at its default sends attributeKeys: null (whole-resource, unchanged from today)', async () => {
      createCredentialShareMock.mockResolvedValue({
        id: 'share-1',
        credentialId,
        fieldKey: null,
        attributeKeys: null,
        action: 'read',
        sharedBy: 'sharer-1',
        recipientUserId: 'recipient-1',
        singleUse: true,
        createdAt: '2026-07-28T00:00:00.000Z',
        expiresAt: '2026-07-29T00:00:00.000Z',
        revokedAt: null,
        firstViewedAt: null,
        viewCount: 0,
        status: 'active',
        token: 'raw-one-time-token',
      })
      render(CredentialDetailPage, {
        props: {
          data: baseData({
            credential: {
              ...CREDENTIAL,
              fields: [
                { key: 'username', sensitive: false },
                { key: 'password', sensitive: true },
              ],
            },
          }),
        },
      })

      await fireEvent.change(screen.getByLabelText(/recipient/i), {
        target: { value: 'recipient-1' },
      })
      await fireEvent.click(screen.getByRole('button', { name: /create share link/i }))

      expect(createCredentialShareMock).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        credentialId,
        expect.objectContaining({ attributeKeys: null })
      )
    })

    it('Story 20.5 AC-9: explicitly checking a sensitive field includes it in attributeKeys (explicit consent)', async () => {
      createCredentialShareMock.mockResolvedValue({
        id: 'share-1',
        credentialId,
        fieldKey: null,
        attributeKeys: ['username', 'password'],
        action: 'read',
        sharedBy: 'sharer-1',
        recipientUserId: 'recipient-1',
        singleUse: true,
        createdAt: '2026-07-28T00:00:00.000Z',
        expiresAt: '2026-07-29T00:00:00.000Z',
        revokedAt: null,
        firstViewedAt: null,
        viewCount: 0,
        status: 'active',
        token: 'raw-one-time-token',
      })
      render(CredentialDetailPage, {
        props: {
          data: baseData({
            credential: {
              ...CREDENTIAL,
              fields: [
                { key: 'username', sensitive: false },
                { key: 'password', sensitive: true },
              ],
            },
          }),
        },
      })

      await fireEvent.change(screen.getByLabelText(/recipient/i), {
        target: { value: 'recipient-1' },
      })
      await fireEvent.click(screen.getByRole('checkbox', { name: /password/i }))
      await fireEvent.click(screen.getByRole('button', { name: /create share link/i }))

      expect(createCredentialShareMock).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        credentialId,
        expect.objectContaining({ attributeKeys: ['username', 'password'] })
      )
    })

    // Bugfix (post-implementation review): `shareAttributeOverrides` is keyed by field key and
    // must never silently carry over to a field set it wasn't recorded against — e.g. if
    // `data.credential.fields` changes underneath the open picker (a concurrent edit re-fetches
    // credential data with a field renamed since the checkbox was toggled). Proves the override
    // is reset (checkboxes fall back to their fresh per-field default) once the field-key set
    // changes, rather than a stale `password` override silently reapplying to an unrelated field
    // that now happens to reuse a key, or the checked-state UI drifting from what will actually be
    // submitted.
    it('Story 20.5 AC-9 bugfix: a share-attribute override is reset when the credential field-key set changes underneath it', async () => {
      const { rerender } = render(CredentialDetailPage, {
        props: {
          data: baseData({
            credential: {
              ...CREDENTIAL,
              fields: [
                { key: 'username', sensitive: false },
                { key: 'password', sensitive: true },
              ],
            },
          }),
        },
      })

      // Explicitly check the sensitive `password` field — an override now exists for that key.
      await fireEvent.click(screen.getByRole('checkbox', { name: /password/i }))
      expect(
        (screen.getByRole('checkbox', { name: /password/i }) as HTMLInputElement).checked
      ).toBe(true)

      // Simulate the field set changing underneath the open form (e.g. a concurrent field-set
      // edit re-fetching `data.credential` with `password` renamed to `secret`).
      await rerender({
        data: baseData({
          credential: {
            ...CREDENTIAL,
            fields: [
              { key: 'username', sensitive: false },
              { key: 'secret', sensitive: true },
            ],
          },
        }),
      })

      // The new sensitive field renders unchecked at its own fresh default — the stale override
      // recorded under the old `password` key must not silently apply to `secret`, nor leave any
      // lingering checked state now that the key it was recorded against no longer exists.
      const secretCheckbox = screen.getByRole('checkbox', { name: /secret/i })
      expect((secretCheckbox as HTMLInputElement).checked).toBe(false)
      expect(screen.queryByRole('checkbox', { name: /password/i })).toBeNull()
    })

    // Bugfix (post-implementation review): a credential whose fields are ALL sensitive has every
    // checkbox unchecked at its own default — a legitimate "default whole-resource" selection per
    // `resolveShareAttributeKeys`, but one AC-2's sensitivity-default-exclusion always reveals as
    // an empty field set. Submitting it must be blocked with guidance, not silently create a share
    // that can never disclose anything.
    it('Story 20.5 AC-9 bugfix: blocks creating a share when every field is sensitive and none is explicitly checked', async () => {
      render(CredentialDetailPage, {
        props: {
          data: baseData({
            credential: {
              ...CREDENTIAL,
              fields: [
                { key: 'apiKey', sensitive: true },
                { key: 'apiSecret', sensitive: true },
              ],
            },
          }),
        },
      })

      await fireEvent.change(screen.getByLabelText(/recipient/i), {
        target: { value: 'recipient-1' },
      })
      await fireEvent.click(screen.getByRole('button', { name: /create share link/i }))

      expect(await screen.findByText(/every field on this credential is sensitive/i)).toBeTruthy()
      expect(createCredentialShareMock).not.toHaveBeenCalled()
    })

    // UX gap fix: mirrors the backend's `AttributeKeysSchema.max(50)` (schema.ts) client-side —
    // checking more than 50 fields must be blocked with a specific message before submission,
    // not left to surface as a generic "Could not create share" after a round-trip 422.
    it('blocks creating a share when more than 50 fields are explicitly checked', async () => {
      const manyFields = Array.from({ length: 51 }, (_, i) => ({
        key: `field-${i}`,
        sensitive: true,
      }))
      render(CredentialDetailPage, {
        props: {
          data: baseData({
            credential: {
              ...CREDENTIAL,
              fields: manyFields,
            },
          }),
        },
      })

      await fireEvent.change(screen.getByLabelText(/recipient/i), {
        target: { value: 'recipient-1' },
      })
      const fieldsToShareGroup = screen.getByRole('group', { name: /fields to share/i })
      const fieldCheckboxes = within(fieldsToShareGroup).getAllByRole('checkbox')
      expect(fieldCheckboxes).toHaveLength(manyFields.length)
      for (const checkbox of fieldCheckboxes) {
        await fireEvent.click(checkbox)
      }
      await fireEvent.click(screen.getByRole('button', { name: /create share link/i }))

      expect(await screen.findByText(/at most 50 fields/i)).toBeTruthy()
      expect(createCredentialShareMock).not.toHaveBeenCalled()
    })

    // Story 18.2 AC-1/AC-2/AC-7: the rendered share link is a full absolute URL (scheme + host +
    // path) built from data.origin, matching the deployment's configured base URL — not a bare
    // relative path — while the token/path portion is unchanged from prior behavior.
    it('Story 18.2: renders the internal share link as an absolute URL using data.origin', async () => {
      createCredentialShareMock.mockResolvedValue({
        id: 'share-1',
        credentialId,
        fieldKey: null,
        sharedBy: 'sharer-1',
        recipientUserId: 'recipient-1',
        singleUse: true,
        createdAt: '2026-07-28T00:00:00.000Z',
        expiresAt: '2026-07-29T00:00:00.000Z',
        revokedAt: null,
        firstViewedAt: null,
        viewCount: 0,
        status: 'active',
        token: 'raw-one-time-token',
      })
      render(CredentialDetailPage, {
        props: { data: baseData({ origin: 'https://vault.example.com' }) },
      })

      await fireEvent.change(screen.getByLabelText(/recipient/i), {
        target: { value: 'recipient-1' },
      })
      // Legacy single-value credential — explicitly opt its one (always-sensitive) implicit field
      // in, or the create-share guard blocks the submission (see the AC-9 bugfix test above).
      await fireEvent.click(screen.getByRole('checkbox', { name: /value/i }))
      await fireEvent.click(screen.getByRole('button', { name: /create share link/i }))

      const link = await screen.findByText('https://vault.example.com/shares/raw-one-time-token')
      expect(link).toBeTruthy()
    })

    // AC-5: if origin resolution ever produced an empty/malformed value, the page must not
    // silently render a broken "https://undefined/shares/..." link — it must fail loudly instead.
    // The +page.server.ts load already guards this (see credential-detail-page.server.test.ts's
    // "fails loudly" case); this proves the client-side render path enforces the same contract
    // via the shared buildAbsoluteUrl helper, in case data.origin is ever empty for any reason.
    it('Story 18.2 AC-5: throws instead of rendering a broken link when data.origin is empty', async () => {
      createCredentialShareMock.mockResolvedValue({
        id: 'share-1',
        credentialId,
        fieldKey: null,
        sharedBy: 'sharer-1',
        recipientUserId: 'recipient-1',
        singleUse: true,
        createdAt: '2026-07-28T00:00:00.000Z',
        expiresAt: '2026-07-29T00:00:00.000Z',
        revokedAt: null,
        firstViewedAt: null,
        viewCount: 0,
        status: 'active',
        token: 'raw-one-time-token',
      })
      render(CredentialDetailPage, { props: { data: baseData({ origin: '' }) } })

      await fireEvent.change(screen.getByLabelText(/recipient/i), {
        target: { value: 'recipient-1' },
      })
      // Legacy single-value credential — explicitly opt its one (always-sensitive) implicit field
      // in, or the create-share guard blocks the submission before origin resolution ever runs.
      await fireEvent.click(screen.getByRole('checkbox', { name: /value/i }))

      await expect(
        fireEvent.click(screen.getByRole('button', { name: /create share link/i }))
      ).rejects.toThrow()
    })

    it('Story 17.2 AC-21: toggling to "External (email)" swaps the recipient input, requires step-up, and posts to the external-share endpoint', async () => {
      createExternalCredentialShareMock.mockResolvedValue({
        id: 'share-ext-1',
        credentialId,
        fieldKey: null,
        sharedBy: 'sharer-1',
        recipientType: 'external',
        recipientUserId: null,
        recipientEmail: 'priya@vendor.example',
        singleUse: true,
        createdAt: '2026-07-28T00:00:00.000Z',
        expiresAt: '2026-07-28T01:00:00.000Z',
        revokedAt: null,
        firstViewedAt: null,
        viewCount: 0,
        status: 'active',
        token: 'raw-external-token',
      })
      render(CredentialDetailPage, { props: { data: baseData() } })

      await fireEvent.click(screen.getByRole('button', { name: /external \(email\)/i }))

      await fireEvent.input(screen.getByLabelText(/recipient email/i), {
        target: { value: 'priya@vendor.example' },
      })
      await fireEvent.input(screen.getByLabelText(/confirm your password/i), {
        target: { value: 'sharer-password' },
      })
      // Legacy single-value credential — explicitly opt its one (always-sensitive) implicit field
      // in, or the create-share guard blocks the submission before it ever reaches the API.
      await fireEvent.click(screen.getByRole('checkbox', { name: /value/i }))
      await fireEvent.click(screen.getByRole('button', { name: /create share link/i }))

      expect(createExternalCredentialShareMock).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        credentialId,
        expect.objectContaining({
          recipientEmail: 'priya@vendor.example',
          password: 'sharer-password',
        })
      )
      expect(await screen.findByText(/raw-external-token/)).toBeTruthy()
      // AC-21: the copy-once link points at the public /external-shares/ route, not /shares/.
      // Story 18.2 AC-1/AC-7: and it's a full absolute URL, not a bare relative path.
      expect(
        screen.getByText('https://vault.example.com/external-shares/raw-external-token')
      ).toBeTruthy()
    })

    it('Story 17.2 AC-21: the singleUse toggle is hidden (always-on) for external shares', async () => {
      render(CredentialDetailPage, { props: { data: baseData() } })

      expect(screen.getByLabelText(/single view only/i)).toBeTruthy()

      await fireEvent.click(screen.getByRole('button', { name: /external \(email\)/i }))

      expect(screen.queryByLabelText(/^single view only$/i)).toBeNull()
      expect(screen.getByText(/single view only \(always on for external shares\)/i)).toBeTruthy()
    })

    it('revokes an active share and updates its status in place', async () => {
      revokeCredentialShareMock.mockResolvedValue({
        id: 'share-1',
        credentialId,
        fieldKey: null,
        sharedBy: 'sharer-1',
        recipientUserId: 'recipient-1',
        singleUse: true,
        createdAt: '2026-07-28T00:00:00.000Z',
        expiresAt: '2026-07-29T00:00:00.000Z',
        revokedAt: '2026-07-28T01:00:00.000Z',
        firstViewedAt: null,
        viewCount: 0,
        status: 'revoked',
      })
      render(CredentialDetailPage, {
        props: {
          data: baseData({
            shares: [
              {
                id: 'share-1',
                credentialId,
                fieldKey: null,
                sharedBy: 'sharer-1',
                recipientUserId: 'recipient-1',
                singleUse: true,
                createdAt: '2026-07-28T00:00:00.000Z',
                expiresAt: '2026-07-29T00:00:00.000Z',
                revokedAt: null,
                firstViewedAt: null,
                viewCount: 0,
                status: 'active',
              },
            ],
          }),
        },
      })

      const revokeButton = screen.getByRole('button', { name: /revoke/i })
      // Story 17.3 AC-1 added a status-filter <select> with a "Revoked" option — capture the
      // share's own list item BEFORE the click (while the Revoke button still uniquely
      // identifies it) so the post-click assertion can scope its query and not collide with
      // that unrelated "Revoked" option text.
      const shareListItem = revokeButton.closest('li') as HTMLElement
      await fireEvent.click(revokeButton)

      expect(revokeCredentialShareMock).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        credentialId,
        'share-1'
      )
      expect(await within(shareListItem).findByText(/revoked/i)).toBeTruthy()
      expect(screen.queryByRole('button', { name: /revoke/i })).toBeNull()
    })
  })

  // Story 17.3 AC-16: rotation-recommended nudge badge on the credential detail header.
  describe('rotation-recommended nudge', () => {
    it('AC-16: shows no badge at all for a credential with no active nudge bucket', () => {
      render(CredentialDetailPage, {
        props: { data: baseData({ rotationRecommendedNudges: [] }) },
      })
      expect(screen.queryByText(/rotation recommended/i)).toBeNull()
    })

    it('AC-16: shows the badge for an active bucket, with a Rotate link and a Dismiss action', () => {
      render(CredentialDetailPage, {
        props: {
          data: baseData({
            rotationRecommendedNudges: [
              {
                fieldKey: null,
                active: true,
                mostRecentShareAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
                mostRecentSharedWith: 'riley@example.com',
              },
            ],
          }),
        },
      })
      expect(screen.getByText(/shared 3 days ago — rotation recommended/i)).toBeTruthy()
      expect(screen.getByRole('link', { name: /rotate now/i })).toBeTruthy()
      expect(screen.getByRole('button', { name: /^dismiss$/i })).toBeTruthy()
    })

    it('AC-15: dismissing requires a non-empty reason and clears the badge on success', async () => {
      dismissRotationRecommendedNudgeMock.mockResolvedValue({
        fieldKey: null,
        dismissedAt: new Date().toISOString(),
      })
      render(CredentialDetailPage, {
        props: {
          data: baseData({
            rotationRecommendedNudges: [
              {
                fieldKey: null,
                active: true,
                mostRecentShareAt: new Date().toISOString(),
                mostRecentSharedWith: null,
              },
            ],
          }),
        },
      })

      await fireEvent.click(screen.getByRole('button', { name: /^dismiss$/i }))
      const confirmButton = screen.getByRole('button', { name: /confirm dismiss/i })
      expect(confirmButton.hasAttribute('disabled')).toBe(true)

      await fireEvent.input(screen.getByPlaceholderText(/reason for dismissing/i), {
        target: { value: 'Rotated out of band' },
      })
      expect(confirmButton.hasAttribute('disabled')).toBe(false)

      await fireEvent.click(confirmButton)

      expect(dismissRotationRecommendedNudgeMock).toHaveBeenCalledWith(
        expect.anything(),
        projectId,
        credentialId,
        { reason: 'Rotated out of band' }
      )
      await vi.waitFor(() => {
        expect(screen.queryByText(/rotation recommended/i)).toBeNull()
      })
    })
  })
})
