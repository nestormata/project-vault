import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClientError } from '$lib/test/api-error.js'

// Story 69.14: the rotation detail page's sections are sub-regions. A probe contribution lands
// BETWEEN the two PV sections it was meant to sit between, the sections render for the same
// statuses and roles as before, and the acknowledgements, the staged value and the working copy of
// the rotation keep ONE owner (the rotation controller) across the sections.

const mocks = vi.hoisted(() => ({
  getRotation: vi.fn(),
  completeRotation: vi.fn(),
  promoteRotation: vi.fn(),
  retireRotation: vi.fn(),
  getStagedValue: vi.fn(),
}))
vi.mock('$app/state', () => ({
  page: {
    route: {
      id: '/(app)/projects/[projectId]/credentials/[credentialId]/rotations/[rotationId]',
    },
    params: {},
  },
}))
vi.mock('$lib/api/rotations.js', () => ({
  ...mocks,
  confirmChecklistItem: vi.fn(),
  failChecklistItem: vi.fn(),
  retryChecklistItem: vi.fn(),
  resumeRotation: vi.fn(),
  abandonRotation: vi.fn(),
}))

const PREFIX = 'project.credentials-rotations-detail.'
const NAMES = ['summary', 'staged-value', 'checklist', 'complete', 'promote', 'abandon', 'retire']
const fills = Object.fromEntries(NAMES.map((name) => [PREFIX + name, [{ marker: `fill:${name}` }]]))

let Detail: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const name of NAMES) {
    vi.doMock(`virtual:pv-inject/${PREFIX}${name}`, () => ({
      default: [{ id: `${name}#0`, order: 0, component: probe }],
    }))
  }
  Detail = (await import('./RotationDetailContent.svelte')).default as unknown as typeof Detail
}, 60_000)
beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset()
  vi.useRealTimers()
})
afterEach(() => {
  cleanup()
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
})

const item = (id: string, status: string, systemName = `system-${id}`) => ({
  id,
  dependencyId: null,
  systemName,
  status,
  confirmedBy: null,
  confirmedAt: null,
  retryCount: 0,
  retryScheduledAt: null,
  lastFailureReason: null,
  lastActedBy: null,
  lastActedAt: null,
})
const MIXED = [item('a', 'confirmed'), item('b', 'unconfirmed')]
const CONFIRMED = [item('a', 'confirmed'), item('b', 'confirmed')]
const rotation = (status: string, checklistItems: unknown[] = MIXED) => ({
  id: 'r1',
  credentialId: 'c1',
  projectId: 'p1',
  status,
  version: 1,
  initiatedBy: null,
  initiatedAt: '2026-10-03T09:00:00.000Z',
  completedAt: null,
  notes: null,
  targetFields: null,
  checklistItems,
})
const pageData = (overrides: Record<string, unknown> = {}) => ({
  projectId: 'p1',
  credentialId: 'c1',
  rotationId: 'r1',
  orgRole: 'owner',
  rotation: rotation('in_progress'),
  notFound: false,
  ...overrides,
})
const mount = (overrides: Record<string, unknown> = {}) =>
  render(Detail, { props: { pageData: pageData(overrides), data: fills } })
const probeFor = (name: string): HTMLElement | undefined =>
  screen.queryAllByTestId('probe').find((el) => el.textContent?.includes(`"fill:${name}"`))
const probe = (name: string): HTMLElement => {
  const found = probeFor(name)
  if (found === undefined) throw new Error(`no probe for ${name}`)
  return found
}
const probeNames = (): string[] => NAMES.filter((name) => probeFor(name) !== undefined)
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
const heading = (name: string): HTMLElement => screen.getByRole('heading', { name })

describe('RotationDetailContent sub-regions (probe order)', () => {
  it('summary: after Refresh, before the checklist', () => {
    mount()
    const summary = probe('summary')
    expect(follows(screen.getByRole('button', { name: 'Refresh' }), summary)).toBe(true)
    expect(follows(summary, heading('Checklist'))).toBe(true)
  })

  it('checklist: after the last row, before the complete section', () => {
    mount()
    const checklist = probe('checklist')
    expect(follows(screen.getByText('system-b'), checklist)).toBe(true)
    expect(follows(checklist, heading('Complete rotation'))).toBe(true)
  })

  it('checklist: still rendered after the empty-state notice with no systems', () => {
    mount({ rotation: rotation('in_progress', []) })
    expect(
      follows(screen.getByText(/No dependent systems were recorded/), probe('checklist'))
    ).toBe(true)
  })

  it('complete: after the Complete button and the progress hint, in an in-progress rotation', () => {
    mount()
    expect(
      follows(screen.getByText(/1 system\(s\) still need confirmation/), probe('complete'))
    ).toBe(true)
    expect(probeNames()).toEqual(['summary', 'checklist', 'complete'])
  })

  it('staged: staged value, checklist, promote, abandon, in that order', () => {
    mount({ rotation: rotation('staged') })
    expect(probeNames()).toEqual(['summary', 'staged-value', 'checklist', 'promote', 'abandon'])
    const staged = probe('staged-value')
    expect(follows(screen.getByRole('button', { name: 'Reveal staged value' }), staged)).toBe(true)
    expect(follows(staged, heading('Checklist'))).toBe(true)
    expect(follows(probe('checklist'), heading('Promote'))).toBe(true)
    expect(follows(screen.getByRole('button', { name: 'Promote' }), probe('promote'))).toBe(true)
    expect(follows(probe('promote'), heading('Abandon'))).toBe(true)
    expect(
      follows(screen.getByRole('button', { name: 'Abandon rotation' }), probe('abandon'))
    ).toBe(true)
  })

  it('promoted: retire follows the Retire button', () => {
    mount({ rotation: rotation('promoted') })
    expect(probeNames()).toEqual(['summary', 'checklist', 'retire'])
    expect(follows(screen.getByRole('button', { name: 'Retire old value' }), probe('retire'))).toBe(
      true
    )
  })

  it.each(['completed', 'retired', 'abandoned', 'stale_recovery'])(
    '%s: only the summary and the checklist',
    (status) => {
      mount({ rotation: rotation(status) })
      expect(probeNames()).toEqual(['summary', 'checklist'])
    }
  )

  it('a member sees the staged value but no manage section; a viewer sees neither', () => {
    mount({ orgRole: 'member', rotation: rotation('staged') })
    expect(probeNames()).toEqual(['summary', 'staged-value', 'checklist'])
    cleanup()
    mount({ orgRole: 'viewer', rotation: rotation('staged') })
    expect(probeNames()).toEqual(['summary', 'checklist'])
    expect(screen.getByText(/You have read access to this rotation/)).toBeTruthy()
  })

  it('renders no sub-region for a sealed vault or a missing rotation', () => {
    mount({ rotation: null, vaultSealed: true })
    expect(screen.queryAllByTestId('probe')).toHaveLength(0)
    cleanup()
    mount({ rotation: null, notFound: true })
    expect(screen.queryAllByTestId('probe')).toHaveLength(0)
    expect(screen.getByText('Rotation not found')).toBeTruthy()
  })
})

describe('RotationDetailContent state across sections (interaction)', () => {
  it('complete: the acknowledgement gates the button, a failure shows under it before the point', async () => {
    mocks.completeRotation.mockRejectedValue(
      apiClientError(422, { code: 'acknowledgement_required', message: 'ack' }, 'ack')
    )
    mount({ rotation: rotation('in_progress', []) })
    const button = screen.getByRole('button', { name: 'Complete rotation' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    await fireEvent.click(screen.getByLabelText(/I confirm this secret is updated/))
    expect(button.disabled).toBe(false)
    await fireEvent.click(button)
    const error = await screen.findByText(/Please confirm the secret is updated everywhere/)
    expect(follows(error, probe('complete'))).toBe(true)
    expect(
      (screen.getByLabelText(/I confirm this secret is updated/) as HTMLInputElement).checked
    ).toBe(false)
  })

  it('promote then retire: the promote acknowledgement is not carried into retire', async () => {
    mocks.promoteRotation.mockResolvedValue(rotation('promoted', []))
    mount({ rotation: rotation('staged', []) })
    const promote = screen.getByRole('button', { name: 'Promote' }) as HTMLButtonElement
    expect(promote.disabled).toBe(true)
    await fireEvent.click(screen.getByLabelText(/I confirm this secret is updated/))
    await fireEvent.click(promote)
    const retire = (await screen.findByRole('button', {
      name: 'Retire old value',
    })) as HTMLButtonElement
    expect(mocks.promoteRotation).toHaveBeenCalledWith(expect.anything(), 'p1', 'c1', 'r1', {
      acknowledgedNoDependencies: true,
    })
    expect(retire.disabled).toBe(true)
    expect(
      (screen.getByLabelText(/I confirm this secret is updated/) as HTMLInputElement).checked
    ).toBe(false)
    expect(probeFor('promote')).toBeUndefined()
    expect(follows(retire, probe('retire'))).toBe(true)
  })

  it('promote with unconfirmed systems needs its own acknowledgement and sends the flag', async () => {
    mocks.promoteRotation.mockResolvedValue(rotation('promoted'))
    mount({ rotation: rotation('staged') })
    const promote = screen.getByRole('button', { name: 'Promote' }) as HTMLButtonElement
    expect(promote.disabled).toBe(true)
    await fireEvent.click(screen.getByLabelText(/Promote even though not every system/))
    expect(promote.disabled).toBe(false)
    await fireEvent.click(promote)
    await screen.findByRole('button', { name: 'Retire old value' })
    expect(mocks.promoteRotation).toHaveBeenCalledWith(expect.anything(), 'p1', 'c1', 'r1', {
      acknowledgeIncompleteChecklist: true,
    })
    expect(screen.getByLabelText(/Retire even though not every system/)).toBeDefined()
  })

  it('retire acknowledgement failure lists the pending systems above the point', async () => {
    mocks.retireRotation.mockRejectedValue(
      apiClientError(
        422,
        {
          code: 'acknowledgement_required',
          message: 'ack',
          totalItemCount: 2,
          pendingItems: [{ systemName: 'system-b' }],
        },
        'ack'
      )
    )
    mount({ rotation: rotation('promoted') })
    await fireEvent.click(screen.getByLabelText(/Retire even though not every system/))
    await fireEvent.click(screen.getByRole('button', { name: 'Retire old value' }))
    const message = await screen.findByText(/acknowledge to retire anyway/)
    expect(follows(message, probe('retire'))).toBe(true)
    expect(follows(screen.getAllByText('system-b')[1] as HTMLElement, probe('retire'))).toBe(true)
  })

  it('reveals the staged value into its section and hides the Reveal button', async () => {
    mocks.getStagedValue.mockResolvedValue({ value: 'new-secret-value' })
    mount({ rotation: rotation('staged', CONFIRMED) })
    await fireEvent.click(screen.getByRole('button', { name: 'Reveal staged value' }))
    const revealed = await screen.findByText('new-secret-value')
    expect(follows(revealed, probe('staged-value'))).toBe(true)
    expect(
      screen.queryAllByTestId('probe').some((p) => p.textContent?.includes('new-secret-value'))
    ).toBe(false)
    expect(screen.queryByRole('button', { name: 'Reveal staged value' })).toBeNull()
  })
})

describe('RotationDetailContent polling (identical to the pre-split page)', () => {
  it('refetches every 15 s while the rotation is active and stops once it is terminal', async () => {
    vi.useFakeTimers()
    mocks.getRotation.mockResolvedValue(rotation('completed'))
    mount()
    await vi.advanceTimersByTimeAsync(14_999)
    expect(mocks.getRotation).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.getRotation).toHaveBeenCalledTimes(1)
    expect(mocks.getRotation).toHaveBeenCalledWith(expect.anything(), 'p1', 'c1', 'r1')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.getRotation).toHaveBeenCalledTimes(1)
    expect(probeNames()).toEqual(['summary', 'checklist'])
  })

  it('does not poll a rotation that loaded terminal', async () => {
    vi.useFakeTimers()
    mount({ rotation: rotation('retired') })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.getRotation).not.toHaveBeenCalled()
  })

  it('pauses while the tab is hidden and resumes when it is visible again', async () => {
    vi.useFakeTimers()
    mocks.getRotation.mockResolvedValue(rotation('in_progress'))
    mount()
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.getRotation).not.toHaveBeenCalled()
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(15_000)
    expect(mocks.getRotation).toHaveBeenCalledTimes(1)
  })

  it('stops polling and removes its listener when the page is destroyed', async () => {
    vi.useFakeTimers()
    mocks.getRotation.mockResolvedValue(rotation('in_progress'))
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    mount()
    cleanup()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.getRotation).not.toHaveBeenCalled()
    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    removeSpy.mockRestore()
  })

  it('resets the working copy to the newly loaded rotation', async () => {
    mocks.completeRotation.mockResolvedValue(rotation('completed', CONFIRMED))
    const view = mount({ rotation: rotation('in_progress', CONFIRMED) })
    await fireEvent.click(screen.getByRole('button', { name: 'Complete rotation' }))
    expect(await screen.findByText('completed')).toBeTruthy()
    await view.rerender({
      pageData: pageData({ rotation: { ...rotation('in_progress', CONFIRMED), id: 'r2' } }),
      data: fills,
    })
    expect(screen.getByText('in_progress')).toBeTruthy()
  })
})
