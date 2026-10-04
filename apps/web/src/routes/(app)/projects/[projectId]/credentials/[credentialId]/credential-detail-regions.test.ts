import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { Component, ComponentProps } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { appLayoutData } from '$lib/test/page-data.js'
import {
  sampleCredential,
  sampleDependency,
  sampleNudge,
  sampleOrgUser,
  sampleProject,
  sampleShare,
} from '$lib/test/fixtures.js'

// Story 69.2 AC-1, AC-3, AC-5: every region of the credential detail page renders its own point
// with the one props contract, forwards the page's `__inject` map aligned to its own point, never
// hands a contribution a display-once value, and keeps the stale-state discipline of 68.1 after the
// extraction (each extracted component owns its state, cleared when the record changes).

// The assertions print localized dates: pin the zone so they do not depend on the machine.
process.env.TZ = 'UTC'

const pageState = vi.hoisted(() => ({
  route: { id: '/(app)/projects/[projectId]/credentials/[credentialId]' } as { id: string | null },
  params: {} as Record<string, string>,
}))
vi.mock('$app/state', () => ({ page: pageState }))

const revealCredentialValueMock = vi.hoisted(() => vi.fn())
const createCredentialShareMock = vi.hoisted(() => vi.fn())
const createExternalCredentialShareMock = vi.hoisted(() => vi.fn())
const updateCredentialLifecycleMock = vi.hoisted(() => vi.fn())
const dismissNudgeMock = vi.hoisted(() => vi.fn())
const listCredentialDependenciesMock = vi.hoisted(() => vi.fn())

vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(async () => {}) }))
vi.mock('$lib/api/credential-shares.js', () => ({
  createCredentialShare: createCredentialShareMock,
  createExternalCredentialShare: createExternalCredentialShareMock,
  revokeCredentialShare: vi.fn(),
  dismissRotationRecommendedNudge: dismissNudgeMock,
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
    listCredentialDependencies: listCredentialDependenciesMock,
    archiveCredential: vi.fn(),
    unarchiveCredential: vi.fn(),
  }
})
vi.mock('$lib/api/rotations.js', async () => {
  const actual =
    await vi.importActual<typeof import('$lib/api/rotations.js')>('$lib/api/rotations.js')
  return { ...actual, confirmChecklistItem: vi.fn() }
})

const REGION_POINTS = [
  'credential.detail.summary',
  'credential.detail.actions',
  'credential.detail.nudges',
  'credential.detail.metadata',
  'credential.detail.lifecycle',
  'credential.detail.value',
  'credential.detail.versions',
  'credential.detail.dependencies',
  'credential.detail.rotation',
  'credential.detail.shares',
  'credential.detail.footer',
] as const
const STANDARD_POINTS = [
  'credential.detail.before',
  'credential.detail.header.actions',
  'credential.detail.after',
] as const
const STATE_POINTS = ['credential.detail.vault-sealed', 'credential.detail.not-found'] as const
const ALL_POINTS = [...STANDARD_POINTS, ...REGION_POINTS, ...STATE_POINTS]

const CONTRACT_KEYS = [
  'credential',
  'credentialId',
  'data',
  'orgRole',
  'params',
  'project',
  'projectId',
  'projectRole',
  'routeId',
]

let Page: Component<{ data: unknown }>
type PageData = ComponentProps<typeof import('./+page.svelte').default>['data']
type LoadedData = Exclude<PageData, { notFound: boolean }>

beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of ALL_POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Page = (await import('./+page.svelte')).default as unknown as typeof Page
})

beforeEach(() => {
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
const credentialBId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const CREDENTIAL = sampleCredential({
  id: credentialId,
  projectId,
  name: 'Stripe Secret Key',
  tags: ['payments'],
  expiresAt: '2026-12-01T00:00:00.000Z',
  rotationSchedule: '0 0 1 * *',
  schemaVersion: 1,
})
const CREDENTIAL_B = sampleCredential({
  ...CREDENTIAL,
  id: credentialBId,
  name: 'Twilio Token',
  expiresAt: '2027-03-15T00:00:00.000Z',
  rotationSchedule: '0 0 * * 1',
})

function baseData(overrides: Partial<LoadedData> = {}): LoadedData {
  return {
    ...appLayoutData(),
    projectId,
    credentialId,
    orgRole: 'member',
    project: sampleProject({ id: projectId, role: 'member' }),
    origin: 'https://vault.example.com',
    credential: CREDENTIAL,
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
    orgMembers: [sampleOrgUser({ userId: 'recipient-1', displayName: 'Riley' })],
    ...overrides,
  }
}

function emptySections(orgRole: LoadedData['orgRole']) {
  return {
    ...baseData({ orgRole }),
    credential: null,
    dependencies: { items: [], hasDependencies: false, hasStagedRotation: false },
  }
}

const dataWithNudge = (extra: Partial<LoadedData>) =>
  baseData({
    rotationRecommendedNudges: [
      sampleNudge({ fieldKey: null, mostRecentShareAt: '2026-07-31T12:00:00.000Z' }),
    ],
    ...extra,
  })

const probes = () => screen.queryAllByTestId('probe')
const parsed = (element: HTMLElement) =>
  JSON.parse(element.textContent ?? 'null') as {
    data: unknown
    [key: string]: unknown
  }

function probeFor(point: string): ReturnType<typeof parsed> {
  const owned = probes()
    .map(parsed)
    .find((props) => props.data === `marker:${point}`)
  if (owned === undefined) throw new Error(`no probe received the entry for ${point}`)
  return owned
}

const allMarkers = (): Record<string, readonly unknown[]> =>
  Object.fromEntries(ALL_POINTS.map((point) => [point, [`marker:${point}`]]))

describe('credential detail points (Story 69.2 AC-1, AC-3)', () => {
  it('renders every standard and region point of the loaded page exactly once, each with its own entry', () => {
    render(Page, { props: { data: { ...baseData(), __inject: allMarkers() } } })
    expect(probes()).toHaveLength(STANDARD_POINTS.length + REGION_POINTS.length)
    for (const point of [...STANDARD_POINTS, ...REGION_POINTS]) probeFor(point)
  })

  it('renders only the sealed region (and the standard points) when the vault is sealed', () => {
    render(Page, {
      props: {
        data: {
          ...emptySections('member'),
          notFound: false,
          vaultSealed: true,
          __inject: allMarkers(),
        },
      },
    })
    expect(probes()).toHaveLength(STANDARD_POINTS.length + 1)
    expect(probeFor('credential.detail.vault-sealed').credential).toBeNull()
  })

  it('renders only the not-found region (and the standard points) for a 404', () => {
    render(Page, {
      props: { data: { ...emptySections('admin'), notFound: true, __inject: allMarkers() } },
    })
    expect(probes()).toHaveLength(STANDARD_POINTS.length + 1)
    const props = probeFor('credential.detail.not-found')
    expect(props.credential).toBeNull()
    expect(props.orgRole).toBe('admin')
    expect(props.projectId).toBe(projectId)
  })

  it('hands every point the same props contract and nothing else', () => {
    render(Page, { props: { data: { ...baseData(), __inject: allMarkers() } } })
    for (const element of probes()) {
      expect(Object.keys(parsed(element)).sort()).toEqual(CONTRACT_KEYS)
    }
    const contractOf = (element: HTMLElement) =>
      Object.fromEntries(Object.entries(parsed(element)).filter(([name]) => name !== 'data'))
    const first = contractOf(probes()[0] as HTMLElement)
    for (const element of probes()) expect(contractOf(element)).toEqual(first)
  })

  it.each([
    ['owner', 'owner'],
    ['admin', 'member'],
    ['member', 'viewer'],
    ['viewer', 'viewer'],
    ['owner', 'member'],
  ] as const)('passes orgRole %s and projectRole %s to the points', (orgRole, projectRole) => {
    render(Page, {
      props: {
        data: {
          ...baseData({ orgRole, project: sampleProject({ id: projectId, role: projectRole }) }),
          __inject: allMarkers(),
        },
      },
    })
    for (const point of ['credential.detail.actions', 'credential.detail.shares']) {
      const props = probeFor(point)
      expect(props.orgRole).toBe(orgRole)
      expect(props.projectRole).toBe(projectRole)
      expect((props.project as { role: string }).role).toBe(projectRole)
      expect((props.credential as { id: string }).id).toBe(credentialId)
    }
  })

  it('passes a null projectRole and project, and does not throw, without a project', () => {
    render(Page, {
      props: { data: { ...baseData({ project: null as never }), __inject: allMarkers() } },
    })
    const props = probeFor('credential.detail.metadata')
    expect(props.project).toBeNull()
    expect(props.projectRole).toBeNull()
  })

  it('renders data = null at every point when the page passes no map, and never throws', () => {
    render(Page, { props: { data: baseData() } })
    expect(probes()).toHaveLength(STANDARD_POINTS.length + REGION_POINTS.length)
    for (const element of probes()) expect(parsed(element).data).toBeNull()
  })

  it('renders data = null when the map holds nothing for a point (aligned, no throw)', () => {
    render(Page, {
      props: { data: { ...baseData(), __inject: { 'unrelated.point.x': ['x'] } } },
    })
    for (const element of probes()) expect(parsed(element).data).toBeNull()
  })

  it('renders the same page markup with and without a map', () => {
    const without = render(Page, { props: { data: baseData() } })
    const html = without.container.innerHTML.replace(/<p data-testid="probe"[^>]*>.*?<\/p>/g, '')
    cleanup()
    const withMap = render(Page, { props: { data: { ...baseData(), __inject: {} } } })
    expect(withMap.container.innerHTML.replace(/<p data-testid="probe"[^>]*>.*?<\/p>/g, '')).toBe(
      html
    )
  })

  it('never hands a contribution a revealed value, a share token or a step-up secret (AC-3)', async () => {
    revealCredentialValueMock.mockResolvedValue({
      value: 'REVEALED-VALUE-FIXTURE',
      versionNumber: 1,
    })
    createExternalCredentialShareMock.mockResolvedValue({
      ...sampleShare({ id: 'new', recipientType: 'external', recipientEmail: 'v@example.com' }),
      token: 'SHARE-TOKEN-FIXTURE',
    })
    render(Page, { props: { data: { ...baseData(), __inject: allMarkers() } } })
    await fireEvent.click(screen.getByRole('button', { name: 'Reveal value' }))
    await waitFor(() => expect(screen.getByText('REVEALED-VALUE-FIXTURE')).toBeTruthy())
    await fireEvent.click(screen.getByRole('button', { name: 'External (email)' }))
    await fireEvent.input(screen.getByLabelText(/Recipient email/), {
      target: { value: 'v@example.com' },
    })
    await fireEvent.input(screen.getByLabelText(/Confirm your password/), {
      target: { value: 'STEP-UP-PASSWORD-FIXTURE' },
    })
    await fireEvent.input(screen.getByLabelText(/fresh authenticator code/), {
      target: { value: '123456' },
    })
    // The step-up values are in the DOM inputs now, before and while the points render.
    const before = probes().map((element) => element.textContent ?? '')
    await fireEvent.click(screen.getByRole('checkbox', { name: /^value/ }))
    await fireEvent.click(screen.getByRole('button', { name: 'Create share link' }))
    await waitFor(() => expect(screen.getByText(/SHARE-TOKEN-FIXTURE/)).toBeTruthy())
    const everything = [...before, ...probes().map((element) => element.textContent ?? '')].join(
      '\n'
    )
    for (const secret of [
      'REVEALED-VALUE-FIXTURE',
      'SHARE-TOKEN-FIXTURE',
      'STEP-UP-PASSWORD-FIXTURE',
      '123456',
    ]) {
      expect(everything).not.toContain(secret)
    }
    // The one-shot token is shown only inside the native sharer body, once.
    expect(screen.getAllByText(/SHARE-TOKEN-FIXTURE/)).toHaveLength(1)
  })
})

describe('credential detail regions: stale state after the extraction (Story 69.2 AC-5)', () => {
  it('the dismiss-nudge input is cleared when the record changes (A -> B)', async () => {
    const { rerender } = render(Page, { props: { data: dataWithNudge({}) } })
    await fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await fireEvent.input(screen.getByPlaceholderText('Reason for dismissing (required)'), {
      target: { value: 'half-typed reason' },
    })
    await rerender({
      data: dataWithNudge({ credentialId: credentialBId, credential: CREDENTIAL_B }),
    })
    expect(screen.queryByPlaceholderText('Reason for dismissing (required)')).toBeNull()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
  })

  it('a dismiss that settles after A -> B is dropped (no state written onto B)', async () => {
    let release: () => void = () => {}
    dismissNudgeMock.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)))
    const { rerender } = render(Page, { props: { data: dataWithNudge({}) } })
    await fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await fireEvent.input(screen.getByPlaceholderText('Reason for dismissing (required)'), {
      target: { value: 'reason on A' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm dismiss' }))
    await rerender({
      data: dataWithNudge({ credentialId: credentialBId, credential: CREDENTIAL_B }),
    })
    release()
    await Promise.resolve()
    // B's own nudge is still active: the settled dismiss of A did not deactivate it.
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
  })

  it('the step-up password and code and the external recipient survive no record change', async () => {
    const { rerender } = render(Page, { props: { data: baseData() } })
    await fireEvent.click(screen.getByRole('button', { name: 'External (email)' }))
    await fireEvent.input(screen.getByLabelText(/Confirm your password/), {
      target: { value: 'half-typed-password' },
    })
    await fireEvent.input(screen.getByLabelText(/fresh authenticator code/), {
      target: { value: '654321' },
    })
    await rerender({ data: baseData({ credentialId: credentialBId, credential: CREDENTIAL_B }) })
    expect((screen.getByLabelText(/Confirm your password/) as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText(/fresh authenticator code/) as HTMLInputElement).value).toBe('')
  })

  it('an in-progress dependent-system form closes and clears when the record changes', async () => {
    const { rerender } = render(Page, { props: { data: baseData() } })
    await fireEvent.click(screen.getByText('Add dependent system', { selector: 'summary' }))
    const opened = screen
      .getByText('Add dependent system', { selector: 'summary' })
      .closest('details') as HTMLDetailsElement
    expect(opened.open).toBe(true)
    // jsdom fires `toggle` asynchronously; deliver it so `bind:open` has seen the disclosure open.
    await fireEvent(opened, new Event('toggle'))
    await fireEvent.input(screen.getByLabelText('System name'), {
      target: { value: 'half-typed-system' },
    })
    await rerender({ data: baseData({ credentialId: credentialBId, credential: CREDENTIAL_B }) })
    const details = screen
      .getByText('Add dependent system', { selector: 'summary' })
      .closest('details') as HTMLDetailsElement
    expect(details.open).toBe(false)
    expect((screen.getByLabelText('System name') as HTMLInputElement).value).toBe('')
  })

  it('a lifecycle save updates the metadata tile with no reload, and A -> B clears the override', async () => {
    updateCredentialLifecycleMock.mockResolvedValue({
      expiresAt: '2030-05-05T00:00:00.000Z',
      rotationSchedule: '0 0 1 * *',
    })
    const { container, rerender } = render(Page, { props: { data: baseData() } })
    await fireEvent.input(screen.getByLabelText('Expiry date'), {
      target: { value: '2030-05-05' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Save lifecycle' }))
    await waitFor(() => expect(container.textContent).toContain('May 5, 2030'))
    await rerender({ data: baseData({ credentialId: credentialBId, credential: CREDENTIAL_B }) })
    expect(container.textContent).not.toContain('May 5, 2030')
    expect(container.textContent).toContain('Mar 15, 2027')
  })

  it('keeps an in-progress lifecycle edit across a reload of the SAME credential', async () => {
    const { rerender } = render(Page, { props: { data: baseData() } })
    await fireEvent.input(screen.getByLabelText('Expiry date'), {
      target: { value: '2031-01-01' },
    })
    await rerender({ data: baseData({ credential: { ...CREDENTIAL, currentVersionNumber: 9 } }) })
    expect((screen.getByLabelText('Expiry date') as HTMLInputElement).value).toBe('2031-01-01')
  })

  it('a lifecycle save that settles after A -> B does not write an override onto B', async () => {
    let release: (value: { expiresAt: string; rotationSchedule: string }) => void = () => {}
    updateCredentialLifecycleMock.mockImplementation(
      () => new Promise((resolve) => (release = resolve))
    )
    const { container, rerender } = render(Page, { props: { data: baseData() } })
    await fireEvent.click(screen.getByRole('button', { name: 'Save lifecycle' }))
    await rerender({ data: baseData({ credentialId: credentialBId, credential: CREDENTIAL_B }) })
    release({ expiresAt: '2040-04-04T00:00:00.000Z', rotationSchedule: '0 0 1 * *' })
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: /Save lifecycle|Saving/ }) as HTMLButtonElement)
          .disabled
      ).toBe(false)
    )
    expect(container.textContent).not.toContain('Apr 4, 2040')
    expect(container.textContent).toContain('Mar 15, 2027')
  })

  it('a reveal started on A that resolves after A -> B shows nothing on B', async () => {
    let release: (value: { value: string; versionNumber: number }) => void = () => {}
    revealCredentialValueMock.mockImplementation(
      () => new Promise((resolve) => (release = resolve))
    )
    const { container, rerender } = render(Page, { props: { data: baseData() } })
    await fireEvent.click(screen.getByRole('button', { name: 'Reveal value' }))
    await rerender({ data: baseData({ credentialId: credentialBId, credential: CREDENTIAL_B }) })
    release({ value: 'SECRET-OF-A', versionNumber: 1 })
    await Promise.resolve()
    await Promise.resolve()
    expect(container.textContent).not.toContain('SECRET-OF-A')
  })
})

describe('credential dependencies poll (Story 69.2 AC-5)', () => {
  const items = [sampleDependency({ id: 'dep-a', systemName: 'billing-worker' })]
  const withItems = () =>
    baseData({ dependencies: { items, hasDependencies: true, hasStagedRotation: false } })

  beforeEach(() => {
    vi.useRealTimers()
    vi.useFakeTimers()
    listCredentialDependenciesMock.mockResolvedValue({
      items,
      hasDependencies: true,
      hasStagedRotation: true,
    })
  })

  function setVisibility(state: 'visible' | 'hidden') {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state })
    document.dispatchEvent(new Event('visibilitychange'))
  }

  afterEach(() => {
    setVisibility('visible')
  })

  it('polls every 15 s while visible, pauses while hidden, resumes, and leaves no timer on destroy', async () => {
    render(Page, { props: { data: withItems() } })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(listCredentialDependenciesMock).toHaveBeenCalledTimes(1)

    setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(45_000)
    expect(listCredentialDependenciesMock).toHaveBeenCalledTimes(1)

    setVisibility('visible')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(listCredentialDependenciesMock).toHaveBeenCalledTimes(2)

    cleanup()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(listCredentialDependenciesMock).toHaveBeenCalledTimes(2)
  })

  it('does not poll a credential with no dependent systems', async () => {
    render(Page, { props: { data: baseData() } })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(listCredentialDependenciesMock).not.toHaveBeenCalled()
  })

  it('applies the polled staged-rotation flag to the rendered rows', async () => {
    const { container } = render(Page, { props: { data: withItems() } })
    expect(container.querySelector('#dependency-updated-dep-a')).toBeNull()
    listCredentialDependenciesMock.mockResolvedValue({
      items: [
        sampleDependency({
          id: 'dep-a',
          systemName: 'billing-worker',
          checklistStatus: {
            rotationId: 'rot-1',
            itemId: 'i1',
            status: 'pending',
            confirmedBy: null,
            confirmedAt: null,
          } as never,
        }),
      ],
      hasDependencies: true,
      hasStagedRotation: true,
    })
    await vi.advanceTimersByTimeAsync(15_000)
    expect(container.querySelector('#dependency-updated-dep-a')).not.toBeNull()
  })
})
