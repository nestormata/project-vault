// @pv-not-guard oracle of PV's own un-composed markup, valid only on PV's tree
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte'
import type { ComponentProps } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeWithoutNoise } from '$lib/test/dom.js'
import { appLayoutData } from '$lib/test/page-data.js'
import {
  sampleCredential,
  sampleDependency,
  sampleNudge,
  sampleOrgUser,
  sampleProject,
  sampleRotation,
  sampleShare,
  sampleVersion,
} from '$lib/test/fixtures.js'

// Story 69.2 AC-2: characterization oracle for the credential detail page extraction. The 68-4
// route-render oracle renders every route against a permissive Proxy, which makes `data.vaultSealed`
// truthy here, so it pins only the vault-sealed banner of this route. This oracle renders the page
// with explicit fixture data (every state and branch of the regions 69.2 extracts, plus the
// interaction states that own local state) and snapshots the normalized markup. The snapshot was
// generated from unmodified `main` (f70efc62) BEFORE any `.svelte` edit and is committed first; it is
// never regenerated. Normalization matches `region-extraction-oracle.test.ts`.

const revealCredentialValueMock = vi.hoisted(() => vi.fn())
const createCredentialShareMock = vi.hoisted(() => vi.fn())
const createExternalCredentialShareMock = vi.hoisted(() => vi.fn())
const updateCredentialLifecycleMock = vi.hoisted(() => vi.fn())

vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(async () => {}) }))
vi.mock('$lib/api/credential-shares.js', () => ({
  createCredentialShare: createCredentialShareMock,
  createExternalCredentialShare: createExternalCredentialShareMock,
  revokeCredentialShare: vi.fn(),
  dismissRotationRecommendedNudge: vi.fn(),
}))
vi.mock('$lib/api/credentials.js', async () => {
  const actual =
    await vi.importActual<typeof import('$lib/api/credentials.js')>('$lib/api/credentials.js')
  return {
    updateCredentialLifecycle: updateCredentialLifecycleMock,
    addCredentialDependency: vi.fn(),
    archiveCredentialDependency: vi.fn(),
    revealCredentialValue: revealCredentialValueMock,
    addCredentialVersion: vi.fn(),
    parseRevealedFields: actual.parseRevealedFields,
    isFieldsValue: actual.isFieldsValue,
    listCredentialDependencies: vi.fn(async () => ({
      items: [],
      hasDependencies: false,
      hasStagedRotation: false,
    })),
    archiveCredential: vi.fn(),
    unarchiveCredential: vi.fn(),
  }
})
vi.mock('$lib/api/rotations.js', async () => {
  const actual =
    await vi.importActual<typeof import('$lib/api/rotations.js')>('$lib/api/rotations.js')
  return { ...actual, confirmChecklistItem: vi.fn() }
})

import CredentialDetailPage from './+page.svelte'

// The snapshot carries localized times (formatDateTime prints hours), so pin the zone: the committed
// markup is the UTC rendering and must not depend on the machine running the test.
process.env.TZ = 'UTC'

beforeEach(() => {
  // Only the clock: waitFor keeps working, and "shared N days ago" / next cron run are stable.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-08-01T12:00:00.000Z'))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
})

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const credentialId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const NOON = '2026-07-01T12:00:00.000Z'
const LATER = '2026-07-15T12:00:00.000Z'

type Data = ComponentProps<typeof CredentialDetailPage>['data']
type LoadedData = Exclude<Data, { notFound: boolean }>

function normalize(root: Element): string {
  return serializeWithoutNoise(root).replace(/\s+/g, ' ').trim()
}

const legacy = sampleCredential({
  id: credentialId,
  projectId,
  name: 'Stripe Secret Key',
  description: 'Payments processor secret',
  tags: ['payments', 'prod'],
  expiresAt: '2026-12-01T00:00:00.000Z',
  rotationSchedule: '0 0 1 * *',
  currentVersionNumber: 3,
  schemaVersion: 1,
  updatedAt: NOON,
})

const multi = sampleCredential({
  id: credentialId,
  projectId,
  name: 'Database login',
  description: null,
  tags: [],
  currentVersionNumber: 2,
  updatedAt: NOON,
  fields: [
    { key: 'host', sensitive: false },
    { key: 'password', sensitive: true },
    { key: 'token', sensitive: true },
  ],
  visibleFieldValues: { host: 'db.internal.example' },
})

function baseData(overrides: Partial<LoadedData> = {}): LoadedData {
  return {
    ...appLayoutData(),
    projectId,
    credentialId,
    orgRole: 'member',
    project: sampleProject({ id: projectId, role: 'member' }),
    origin: 'https://vault.example.com',
    credential: legacy,
    dependencies: { items: [], hasDependencies: false, hasStagedRotation: false },
    versions: [],
    rotations: [],
    rotationsPage: 1,
    rotationsHasMore: false,
    activeRotationId: null,
    shares: [],
    sharesTotal: 0,
    sharesPage: 1,
    sharesStatus: null,
    rotationRecommendedNudges: [],
    orgMembers: [
      sampleOrgUser({ userId: 'recipient-1', email: 'riley@invalid', displayName: 'Riley' }),
      sampleOrgUser({ userId: 'recipient-2', email: 'sam@invalid', displayName: '' }),
    ],
    ...overrides,
  }
}

function emptySections(orgRole: LoadedData['orgRole']) {
  return {
    ...appLayoutData(),
    projectId,
    credentialId,
    orgRole,
    project: sampleProject({ id: projectId, role: 'member' }),
    origin: 'https://vault.example.com',
    credential: null,
    versions: [],
    dependencies: { items: [], hasDependencies: false, hasStagedRotation: false },
    rotations: [],
    rotationsPage: 1,
    rotationsHasMore: false,
    activeRotationId: null,
    shares: [],
    sharesTotal: 0,
    rotationRecommendedNudges: [],
    orgMembers: [],
  }
}

const owner = (credential = legacy) =>
  baseData({
    credential,
    orgRole: 'owner',
    project: sampleProject({ id: projectId, role: 'owner' }),
  })

function renderPage(data: Data): string {
  const { container } = render(CredentialDetailPage, { props: { data } })
  const html = normalize(container)
  cleanup()
  return html
}

const versions = [
  sampleVersion({ versionNumber: 3, isCurrent: true, createdAt: LATER }),
  sampleVersion({ versionNumber: 2, isCurrent: false, createdAt: NOON }),
]

const rotations = [
  sampleRotation({
    id: 'rot-1',
    status: 'completed',
    initiatedAt: NOON,
    completedAt: LATER,
    itemCount: 3,
    confirmedCount: 3,
  }),
  sampleRotation({ id: 'rot-2', status: 'in_progress', initiatedAt: LATER, itemCount: 2 }),
]

const checklist = (status: string, itemId: string) => ({
  rotationId: 'rot-9',
  itemId,
  status,
  confirmedBy: status === 'confirmed' ? 'user-1' : null,
  confirmedAt: status === 'confirmed' ? NOON : null,
})

const dependencies = {
  items: [
    sampleDependency({ id: 'dep-plain', systemName: 'billing-worker', systemType: 'service' }),
    sampleDependency({
      id: 'dep-scoped',
      systemName: 'ci-deploy',
      systemType: 'ci_pipeline',
      fieldKey: 'password',
      linkUrl: 'https://ci.example.com/pipelines/1',
    }),
    sampleDependency({
      id: 'dep-pending',
      systemName: 'pending-system',
      checklistStatus: checklist('pending', 'i1') as never,
    }),
    sampleDependency({
      id: 'dep-confirmed',
      systemName: 'confirmed-system',
      checklistStatus: checklist('confirmed', 'i2') as never,
    }),
    sampleDependency({
      id: 'dep-failed',
      systemName: 'failed-system',
      checklistStatus: checklist('failed', 'i3') as never,
    }),
    sampleDependency({
      id: 'dep-max',
      systemName: 'maxed-system',
      checklistStatus: checklist('max_retries_exceeded', 'i4') as never,
    }),
  ],
  hasDependencies: true,
  hasStagedRotation: true,
}

const shares = [
  sampleShare({
    id: 's1',
    recipientUserId: 'recipient-1',
    status: 'active',
    attributeKeys: ['a', 'b'],
  }),
  sampleShare({
    id: 's2',
    recipientType: 'external',
    recipientUserId: null,
    recipientEmail: 'vendor-contact@invalid',
    status: 'viewed',
    firstViewedAt: LATER,
    fieldKey: 'password',
  }),
  sampleShare({ id: 's3', recipientUserId: 'unknown-user', status: 'revoked' }),
  sampleShare({ id: 's4', recipientUserId: 'recipient-2', status: 'expired' }),
]

function staticMatrix(): Record<string, string> {
  const out: Record<string, string> = {}
  out['loaded legacy member, empty sections'] = renderPage(baseData())
  out['loaded legacy member, everything populated'] = renderPage(
    baseData({
      versions,
      rotations,
      rotationsHasMore: true,
      rotationsPage: 2,
      dependencies,
      shares,
      sharesTotal: 60,
      sharesPage: 2,
      sharesStatus: 'active',
      rotationRecommendedNudges: [
        sampleNudge({ fieldKey: null, mostRecentShareAt: '2026-07-31T12:00:00.000Z' }),
        sampleNudge({ fieldKey: 'password', mostRecentShareAt: '2026-07-20T12:00:00.000Z' }),
        sampleNudge({ fieldKey: 'token', active: false }),
      ],
    })
  )
  out['loaded legacy owner (archive button), no description/tags/expiry'] = renderPage(
    owner(sampleCredential({ ...legacy, description: null, tags: [], expiresAt: null }))
  )
  out['loaded legacy, org owner on a member project'] = renderPage(
    baseData({ orgRole: 'owner', project: sampleProject({ id: projectId, role: 'member' }) })
  )
  out['loaded legacy org admin'] = renderPage(baseData({ orgRole: 'admin' }))
  out['loaded legacy org viewer'] = renderPage(
    baseData({ orgRole: 'viewer', project: sampleProject({ id: projectId, role: 'viewer' }) })
  )
  out['loaded legacy org member, project viewer'] = renderPage(
    baseData({ project: sampleProject({ id: projectId, role: 'viewer' }) })
  )
  out['loaded legacy, project null'] = renderPage(baseData({ project: null as never }))
  out['loaded multi-field owner, all sections'] = renderPage({
    ...owner(multi),
    versions,
    rotations,
    dependencies,
    shares,
    sharesTotal: 4,
    rotationRecommendedNudges: [sampleNudge({ fieldKey: 'token' })],
  } as LoadedData)
  out['loaded multi-field viewer'] = renderPage(
    baseData({
      credential: multi,
      orgRole: 'viewer',
      project: sampleProject({ id: projectId, role: 'viewer' }),
    })
  )
  out['loaded multi-field, all fields sensitive'] = renderPage(
    owner(
      sampleCredential({
        ...multi,
        fields: [
          { key: 'a', sensitive: true },
          { key: 'b', sensitive: true },
        ],
        visibleFieldValues: {},
      })
    )
  )
  out['archived credential, owner'] = renderPage(
    owner(sampleCredential({ ...legacy, archivedAt: LATER }))
  )
  out['archived multi-field credential, owner, with dependencies and shares'] = renderPage({
    ...owner(sampleCredential({ ...multi, archivedAt: LATER })),
    dependencies,
    shares,
    sharesTotal: 4,
  } as LoadedData)
  out['archived credential, member, rotation manager disabled'] = renderPage(
    baseData({ credential: sampleCredential({ ...legacy, archivedAt: LATER }), orgRole: 'admin' })
  )
  out['active rotation, admin'] = renderPage(
    baseData({ orgRole: 'admin', activeRotationId: 'rot-2', rotations })
  )
  out['rotation start link, admin'] = renderPage(baseData({ orgRole: 'admin' }))
  out['dependencies empty, viewer'] = renderPage(
    baseData({ orgRole: 'viewer', project: sampleProject({ id: projectId, role: 'viewer' }) })
  )
  out['dependencies without staged rotation, member'] = renderPage(
    baseData({ dependencies: { ...dependencies, hasStagedRotation: false } })
  )
  out['shares first page with next link'] = renderPage(
    baseData({ shares, sharesTotal: 60, sharesPage: 1 })
  )
  out['shares last page with previous link'] = renderPage(
    baseData({ shares, sharesTotal: 30, sharesPage: 2 })
  )
  out['shares filtered, none'] = renderPage(baseData({ sharesStatus: 'revoked' }))
  out['shares total missing'] = renderPage(
    baseData({ shares, sharesTotal: undefined as never, sharesPage: undefined as never })
  )
  for (const orgRole of ['owner', 'admin', 'member', 'viewer'] as const) {
    out[`not found, ${orgRole}`] = renderPage({ ...emptySections(orgRole), notFound: true })
    out[`vault sealed, ${orgRole}`] = renderPage({
      ...emptySections(orgRole),
      notFound: false,
      vaultSealed: true,
    })
  }
  out['credential null without notFound flag'] = renderPage({
    ...emptySections('member'),
    notFound: false,
  } as unknown as Data)
  return out
}

async function click(name: string | RegExp): Promise<void> {
  await fireEvent.click(screen.getByRole('button', { name }))
}

async function interactionStates(): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const html = (container: Element) => normalize(container)

  // Legacy single-field: reveal, then hide.
  revealCredentialValueMock.mockResolvedValue({ value: 'LEGACY-VALUE-FIXTURE', versionNumber: 3 })
  let mounted = render(CredentialDetailPage, { props: { data: baseData() } })
  await click('Reveal value')
  await waitFor(() => expect(screen.getByText('LEGACY-VALUE-FIXTURE')).toBeTruthy())
  out['legacy revealed'] = html(mounted.container)
  await click('Hide')
  out['legacy hidden again'] = html(mounted.container)
  cleanup()

  // Legacy reveal that fails.
  revealCredentialValueMock.mockRejectedValueOnce(new Error('reveal boom'))
  mounted = render(CredentialDetailPage, { props: { data: baseData() } })
  await click('Reveal value')
  await waitFor(() => expect(screen.getByText('reveal boom')).toBeTruthy())
  out['legacy reveal error'] = html(mounted.container)
  cleanup()

  // Copy without reveal: success and failure statuses (clipboard stubbed).
  const writeText = vi.fn(async () => {})
  Object.assign(navigator, { clipboard: { writeText } })
  revealCredentialValueMock.mockResolvedValue({ value: 'COPY-VALUE-FIXTURE', versionNumber: 3 })
  mounted = render(CredentialDetailPage, { props: { data: baseData() } })
  await click(/copy/i)
  await waitFor(() => expect(writeText).toHaveBeenCalled())
  await waitFor(() => expect(screen.getAllByRole('status').length).toBeGreaterThan(0))
  out['legacy copy without reveal, success status'] = html(mounted.container)
  cleanup()

  // Multi-field: per-field reveal, reveal all, edit fields.
  revealCredentialValueMock.mockImplementation(
    async (_f: unknown, _p: string, _c: string, opts?: { field?: string }) =>
      opts?.field
        ? {
            fields: [{ key: opts.field, sensitive: true, value: `FIELD-${opts.field}` }],
            versionNumber: 2,
          }
        : {
            fields: [
              { key: 'host', sensitive: false, value: 'db.internal.example' },
              { key: 'password', sensitive: true, value: 'FIELD-password' },
              { key: 'token', sensitive: true, value: 'FIELD-token' },
            ],
            versionNumber: 2,
          }
  )
  mounted = render(CredentialDetailPage, { props: { data: owner(multi) } })
  const passwordRow = screen.getByTestId('field-row-password')
  await fireEvent.click(within(passwordRow).getByRole('button', { name: 'Reveal' }))
  await waitFor(() => expect(screen.getByTestId('field-value-password')).toBeTruthy())
  out['multi one field revealed'] = html(mounted.container)
  await fireEvent.click(within(passwordRow).getByRole('button', { name: 'Hide' }))
  out['multi field hidden again'] = html(mounted.container)
  await click('Reveal all')
  await waitFor(() => expect(screen.getByTestId('field-value-token')).toBeTruthy())
  out['multi all revealed'] = html(mounted.container)
  await click('Edit fields')
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save fields' })).toBeTruthy())
  out['multi field-set editor open'] = html(mounted.container)
  await click('Cancel')
  out['multi field-set editor cancelled'] = html(mounted.container)
  cleanup()

  // Multi-field per-field reveal that fails.
  revealCredentialValueMock.mockRejectedValueOnce(new Error('field boom'))
  mounted = render(CredentialDetailPage, { props: { data: owner(multi) } })
  await fireEvent.click(
    within(screen.getByTestId('field-row-token')).getByRole('button', { name: 'Reveal' })
  )
  await waitFor(() => expect(screen.getByText('field boom')).toBeTruthy())
  out['multi per-field reveal error'] = html(mounted.container)
  cleanup()

  // Nudge dismissal form open.
  mounted = render(CredentialDetailPage, {
    props: {
      data: baseData({
        rotationRecommendedNudges: [
          sampleNudge({ fieldKey: null, mostRecentShareAt: '2026-07-31T12:00:00.000Z' }),
        ],
      }),
    },
  })
  await click('Dismiss')
  out['nudge dismiss form open'] = html(mounted.container)
  const reason = screen.getByPlaceholderText('Reason for dismissing (required)')
  await fireEvent.input(reason, { target: { value: 'handled out of band' } })
  out['nudge dismiss form with reason'] = html(mounted.container)
  cleanup()

  // Dependency form open with a validation error.
  mounted = render(CredentialDetailPage, { props: { data: baseData() } })
  await fireEvent.click(screen.getByText('Add dependent system', { selector: 'summary' }))
  out['dependency form open'] = html(mounted.container)
  const nameInput = screen.getByLabelText('System name')
  await fireEvent.input(nameInput, { target: { value: '   ' } })
  await fireEvent.submit(nameInput.closest('form') as HTMLFormElement)
  out['dependency form name error'] = html(mounted.container)
  cleanup()

  // Multi-field dependency form shows the field scope selector.
  mounted = render(CredentialDetailPage, { props: { data: owner(multi) } })
  await fireEvent.click(screen.getByText('Add dependent system', { selector: 'summary' }))
  out['dependency form open, multi-field scope selector'] = html(mounted.container)
  cleanup()

  // Add new version error (legacy).
  mounted = render(CredentialDetailPage, { props: { data: baseData() } })
  await click('Add version')
  out['add version empty value error'] = html(mounted.container)
  cleanup()

  // Lifecycle: invalid cron help, then a successful save updates the Expires tile.
  updateCredentialLifecycleMock.mockResolvedValue({
    expiresAt: '2027-01-01T00:00:00.000Z',
    rotationSchedule: '0 0 1 * *',
  })
  mounted = render(CredentialDetailPage, { props: { data: baseData() } })
  await fireEvent.input(screen.getByLabelText(/Rotation schedule/), {
    target: { value: '*/5 * * * *' },
  })
  out['lifecycle schedule interpretation'] = html(mounted.container)
  await fireEvent.input(screen.getByLabelText('Expiry date'), { target: { value: '2027-01-01' } })
  await click('Save lifecycle')
  await waitFor(() => expect(updateCredentialLifecycleMock).toHaveBeenCalled())
  await waitFor(() => expect(mounted.container.textContent).toContain('Jan 1, 2027'))
  out['lifecycle saved, metadata tile updated'] = html(mounted.container)
  cleanup()

  updateCredentialLifecycleMock.mockRejectedValueOnce(new Error('lifecycle boom'))
  mounted = render(CredentialDetailPage, { props: { data: baseData() } })
  await click('Save lifecycle')
  await waitFor(() => expect(screen.getByText('lifecycle boom')).toBeTruthy())
  out['lifecycle save error'] = html(mounted.container)
  cleanup()

  // Shares: external recipient form, then a created member share with its one-time link.
  mounted = render(CredentialDetailPage, { props: { data: baseData() } })
  await click('External (email)')
  out['share form external recipient'] = html(mounted.container)
  cleanup()

  createCredentialShareMock.mockResolvedValue({
    ...sampleShare({ id: 'new-share', recipientUserId: 'recipient-1' }),
    token: 'MEMBERTOKENFIXTURE',
  })
  mounted = render(CredentialDetailPage, { props: { data: baseData() } })
  await fireEvent.change(screen.getByLabelText(/Recipient/), { target: { value: 'recipient-1' } })
  await fireEvent.click(screen.getByRole('checkbox', { name: /^value/ }))
  await click('Create share link')
  await waitFor(() => expect(screen.getByText(/MEMBERTOKENFIXTURE/)).toBeTruthy())
  out['member share created, link shown once'] = html(mounted.container)
  cleanup()

  createExternalCredentialShareMock.mockResolvedValue({
    ...sampleShare({
      id: 'new-ext',
      recipientType: 'external',
      recipientUserId: null,
      recipientEmail: 'vendor-contact@invalid',
    }),
    token: 'EXTERNALTOKENFIXTURE',
  })
  mounted = render(CredentialDetailPage, { props: { data: baseData() } })
  await click('External (email)')
  await fireEvent.input(screen.getByLabelText(/Recipient email/), {
    target: { value: 'vendor-contact@invalid' },
  })
  await fireEvent.click(screen.getByRole('checkbox', { name: /^value/ }))
  await click('Create share link')
  await waitFor(() => expect(screen.getByText(/EXTERNALTOKENFIXTURE/)).toBeTruthy())
  out['external share created, link and notice shown'] = html(mounted.container)
  cleanup()

  createCredentialShareMock.mockRejectedValueOnce(new Error('share boom'))
  mounted = render(CredentialDetailPage, { props: { data: baseData() } })
  await fireEvent.change(screen.getByLabelText(/Recipient/), { target: { value: 'recipient-1' } })
  await fireEvent.click(screen.getByRole('checkbox', { name: /^value/ }))
  await click('Create share link')
  await waitFor(() => expect(screen.getByText('share boom')).toBeTruthy())
  out['share create error'] = html(mounted.container)
  cleanup()

  return out
}

describe('credential detail render oracle (Story 69.2 AC-2)', () => {
  it('renders the credential page exactly as before the extraction', async () => {
    const result = { ...staticMatrix(), ...(await interactionStates()) }
    await expect(`${JSON.stringify(result, null, 2)}\n`).toMatchFileSnapshot(
      './credential-detail-render.snapshot.json'
    )
    expect(Object.keys(result).length).toBeGreaterThanOrEqual(50)
    // One test renders ~60 states and drives ~25 interactions: about 4 s alone and 8 s on a loaded
    // machine, so the 5 s default would flake. Measured, not a wall-clock assertion.
  }, 30_000)
})
