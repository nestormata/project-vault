import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'
import { credentialPointExtras } from '$lib/credentials/credential-detail-helpers.js'
import { sampleCredential, sampleProject } from '$lib/test/fixtures.js'

// Story 72.8 (P11): the reveal contract of the Secret value section: auto-hide after 30 s, Extend as a
// NEW server reveal, hide on tab hidden / route change / bfcache restore, copy marked as a copy.

const revealMock = vi.hoisted(() => vi.fn())
const addVersionMock = vi.hoisted(() => vi.fn())
vi.mock('$app/state', () => ({
  page: {
    route: { id: '/(app)/projects/[projectId]/credentials/[credentialId]' },
    params: {},
  },
}))
vi.mock('$app/navigation', () => ({
  beforeNavigate: vi.fn(),
  invalidateAll: vi.fn(async () => undefined),
}))
vi.mock('$lib/api/credentials.js', async () => {
  const actual =
    await vi.importActual<typeof import('$lib/api/credentials.js')>('$lib/api/credentials.js')
  return {
    parseRevealedFields: actual.parseRevealedFields,
    isFieldsValue: actual.isFieldsValue,
    revealCredentialValue: revealMock,
    addCredentialVersion: addVersionMock,
  }
})

const POINTS = [
  'credential.detail.value',
  'credential.detail.value-fields',
  'credential.detail.value-single',
  'credential.detail.value-copy-status',
  'credential.detail.value-edit-fields',
  'credential.detail.value-add-version',
] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const credentialId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const LEGACY = sampleCredential({ id: credentialId, projectId })
const MULTI = sampleCredential({
  id: credentialId,
  projectId,
  fields: [
    { key: 'host', sensitive: false },
    { key: 'password', sensitive: true },
  ],
  visibleFieldValues: { host: 'db.internal.example' },
})

let Section: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Section = (await import('./CredentialValueSection.svelte')).default as unknown as typeof Section
}, 60_000)
beforeEach(() => {
  revealMock.mockReset()
  addVersionMock.mockReset()
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } })
})
afterEach(() => cleanup())

function propsFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = {
    credential: LEGACY,
    projectId,
    credentialId,
    orgRole: 'member' as const,
    project: sampleProject({ id: projectId, role: 'member' }),
  }
  const merged = { ...base, ...overrides } as typeof base
  return {
    ...merged,
    pointProps: credentialPointExtras(merged),
    data: fills,
  }
}
const mount = (overrides: Record<string, unknown> = {}) =>
  render(Section, { props: propsFor(overrides) })
const button = (name: string | RegExp): HTMLElement => screen.getByRole('button', { name })

const SECRET = 'REVEAL-CONTRACT-FIXTURE'

function revealOnce(value = SECRET) {
  revealMock.mockResolvedValueOnce({ value, versionNumber: 3 })
}

function setVisibility(state: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('reveal contract (72-8)', () => {
  afterEach(() => {
    vi.useRealTimers()
    setVisibility('visible')
  })

  it('auto-hides a revealed value after 30 seconds, not before', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    revealOnce()
    mount()
    await fireEvent.click(button('Reveal value'))
    await waitFor(() => expect(screen.getByText(SECRET)).toBeTruthy())
    await vi.advanceTimersByTimeAsync(29_000)
    expect(screen.queryByText(SECRET)).not.toBeNull()
    await vi.advanceTimersByTimeAsync(1_500)
    await waitFor(() => expect(screen.queryByText(SECRET)).toBeNull())
    expect(screen.queryByRole('button', { name: 'Extend' })).toBeNull()
  })

  it('Extend is a NEW server reveal that re-arms the 30 second window', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    revealOnce()
    revealOnce()
    mount()
    await fireEvent.click(button('Reveal value'))
    await waitFor(() => expect(screen.getByText(SECRET)).toBeTruthy())
    await vi.advanceTimersByTimeAsync(20_000)
    await fireEvent.click(button('Extend'))
    await waitFor(() => expect(revealMock).toHaveBeenCalledTimes(2))
    // 20 s + 20 s: past the first window, inside the second.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(screen.queryByText(SECRET)).not.toBeNull()
    await vi.advanceTimersByTimeAsync(11_000)
    await waitFor(() => expect(screen.queryByText(SECRET)).toBeNull())
  })

  it('a failed Extend hides the value instead of leaving it on screen', async () => {
    revealOnce()
    revealMock.mockRejectedValueOnce(
      new ApiClientError(403, { code: 'insufficient_project_role', message: 'nope' }, 'nope')
    )
    mount()
    await fireEvent.click(button('Reveal value'))
    await waitFor(() => expect(screen.getByText(SECRET)).toBeTruthy())
    await fireEvent.click(button('Extend'))
    await waitFor(() => expect(revealMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText(SECRET)).toBeNull())
  })

  it('drops a reveal that lands after the tab was hidden', async () => {
    let resolve: (value: unknown) => void = () => undefined
    revealMock.mockReturnValueOnce(new Promise((r) => (resolve = r)))
    mount()
    await fireEvent.click(button('Reveal value'))
    setVisibility('hidden')
    resolve({ value: SECRET, versionNumber: 3 })
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /reveal value/i })).not.toBeNull()
    )
    expect(screen.queryByText(SECRET)).toBeNull()
  })

  it('hides when the tab becomes hidden', async () => {
    revealOnce()
    mount()
    await fireEvent.click(button('Reveal value'))
    await waitFor(() => expect(screen.getByText(SECRET)).toBeTruthy())
    setVisibility('hidden')
    await waitFor(() => expect(screen.queryByText(SECRET)).toBeNull())
  })

  it('hides on a bfcache restore (pageshow persisted) but not on a normal pageshow', async () => {
    revealOnce()
    mount()
    await fireEvent.click(button('Reveal value'))
    await waitFor(() => expect(screen.getByText(SECRET)).toBeTruthy())
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }))
    expect(screen.queryByText(SECRET)).not.toBeNull()
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    await waitFor(() => expect(screen.queryByText(SECRET)).toBeNull())
  })

  it('registers a before-navigation hide and leaves nothing behind after unmount', async () => {
    const { beforeNavigate } = await import('$app/navigation')
    revealOnce()
    const view = mount()
    expect(beforeNavigate).toHaveBeenCalled()
    await fireEvent.click(button('Reveal value'))
    await waitFor(() => expect(screen.getByText(SECRET)).toBeTruthy())
    view.unmount()
    expect(document.body.textContent).not.toContain(SECRET)
  })

  it('hides every revealed field together, and each field Extend re-reveals only that field', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    revealMock.mockResolvedValue({
      fields: [{ key: 'password', value: SECRET, sensitive: true }],
      schemaVersion: 2,
      versionNumber: 3,
    })
    mount({ credential: MULTI })
    await fireEvent.click(button('Reveal'))
    await waitFor(() => expect(screen.getByTestId('field-value-password')).toBeTruthy())
    await fireEvent.click(button('Extend password'))
    await waitFor(() => expect(revealMock).toHaveBeenCalledTimes(2))
    expect(revealMock.mock.calls[1]?.[3]).toEqual({ field: 'password' })
    setVisibility('hidden')
    await waitFor(() => expect(screen.queryByTestId('field-value-password')).toBeNull())
    expect(screen.getByTestId('field-masked-password')).toBeTruthy()
  })

  it('copy without reveal is requested as a copy, never as a view', async () => {
    revealMock.mockResolvedValueOnce({ value: SECRET, versionNumber: 3 })
    mount()
    await fireEvent.click(button(/copy secret value without revealing/i))
    await waitFor(() => expect(revealMock).toHaveBeenCalledTimes(1))
    expect(revealMock.mock.calls[0]?.[3]).toEqual({ purpose: 'copy' })
    expect(screen.queryByText(SECRET)).toBeNull()
  })

  it('states one clipboard limit and never promises an automatic clear', async () => {
    mount()
    const text = document.body.textContent ?? ''
    expect(text).toMatch(/cannot clear your clipboard/i)
    expect(text).not.toMatch(/auto-?clear|clears? (your|the) clipboard (after|automatically)/i)
  })
})
