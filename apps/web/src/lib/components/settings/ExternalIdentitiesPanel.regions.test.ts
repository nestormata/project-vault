import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'

// Story 69.11: the external identities panel's sections are sub-regions. A probe contribution
// lands after its own section, the link form owns its typed values, and the list owns the shared
// unlink state of its rows.

const api = vi.hoisted(() => ({
  linkExternalIdentity: vi.fn(),
  unlinkExternalIdentity: vi.fn(),
  invalidateAll: vi.fn(),
}))
vi.mock('$app/state', () => ({
  page: { route: { id: '/(app)/settings/external-identities' }, params: {} },
}))
vi.mock('$app/navigation', () => ({ invalidateAll: api.invalidateAll }))
vi.mock('$lib/api/external-identities.js', () => ({
  linkExternalIdentity: api.linkExternalIdentity,
  unlinkExternalIdentity: api.unlinkExternalIdentity,
}))

const POINTS = ['settings.external-identities.link', 'settings.external-identities.list'] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))
const IDENTITIES = [
  {
    id: 'ei-1',
    email: 'alex@example.com',
    providerName: 'p.one',
    externalSubject: 'alex-subject',
    createdAt: '2026-10-01T10:00:00.000Z',
  },
  {
    id: 'ei-2',
    email: 'sam@example.com',
    providerName: 'p.two',
    externalSubject: 'sam-subject',
    createdAt: '2026-10-02T10:00:00.000Z',
  },
]
const USERS = [{ userId: 'u-alex', email: 'alex@example.com' }]
const allowed = (overrides: Record<string, unknown> = {}) => ({
  allowed: true,
  mfaRequired: false,
  errorMessage: null,
  identities: IDENTITIES,
  orgUsers: USERS,
  ...overrides,
})

let Panel: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Panel = (await import('./ExternalIdentitiesPanel.svelte')).default as unknown as typeof Panel
}, 60_000)
beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  for (const fn of Object.values(api)) fn.mockReset()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const mount = (pageData: Record<string, unknown> = allowed()) =>
  render(Panel, { props: { pageData, data: fills } })
const probe = (point: string): HTMLElement => {
  const found = screen
    .getAllByTestId('probe')
    .find((el) => el.textContent?.includes(`"fill:${point}"`))
  if (found === undefined) throw new Error(`no probe for ${point}`)
  return found
}
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
const byId = (id: string) => document.getElementById(id) as HTMLInputElement

describe('ExternalIdentitiesPanel sub-regions (probe order)', () => {
  it('link: after the form button, before the identities table', () => {
    mount()
    const link = probe('settings.external-identities.link')
    expect(follows(screen.getByRole('button', { name: 'Link identity' }), link)).toBe(true)
    expect(follows(link, screen.getByRole('table'))).toBe(true)
  })

  it('list: after the last row of the table', () => {
    mount()
    const rows = screen.getAllByRole('row')
    expect(
      follows(rows[rows.length - 1] as HTMLElement, probe('settings.external-identities.list'))
    ).toBe(true)
  })

  it('list: still rendered (after the empty-state notice) when nothing is linked', () => {
    mount(allowed({ identities: [] }))
    expect(
      follows(
        screen.getByText('No external identities linked yet.'),
        probe('settings.external-identities.list')
      )
    ).toBe(true)
  })

  it('renders no sub-region for a non-admin or an MFA-less admin', () => {
    mount({ allowed: false })
    expect(screen.queryAllByTestId('probe')).toHaveLength(0)
    cleanup()
    mount(allowed({ mfaRequired: true }))
    expect(screen.queryAllByTestId('probe')).toHaveLength(0)
  })
})

describe('ExternalIdentitiesPanel state (interaction)', () => {
  const fillForm = async () => {
    await fireEvent.change(byId('new-user'), { target: { value: 'u-alex' } })
    await fireEvent.input(byId('new-provider-name'), { target: { value: 'corp.idp' } })
    await fireEvent.input(byId('new-external-subject'), { target: { value: 'sub-1' } })
  }

  it('keeps Link disabled until member, provider and subject are all set', async () => {
    mount()
    const button = screen.getByRole('button', { name: 'Link identity' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    await fillForm()
    expect(button.disabled).toBe(false)
  })

  it('links, clears the typed values and reloads', async () => {
    api.linkExternalIdentity.mockResolvedValue(undefined)
    mount()
    await fillForm()
    await fireEvent.click(screen.getByRole('button', { name: 'Link identity' }))
    await waitFor(() =>
      expect(api.linkExternalIdentity).toHaveBeenCalledWith(fetch, {
        userId: 'u-alex',
        providerName: 'corp.idp',
        externalSubject: 'sub-1',
      })
    )
    await waitFor(() => expect(api.invalidateAll).toHaveBeenCalled())
    await waitFor(() => expect(byId('new-provider-name').value).toBe(''))
  })

  it('surfaces a documented error code verbatim and masks any other error', async () => {
    api.linkExternalIdentity.mockRejectedValueOnce(
      new ApiClientError(409, { code: 'conflict' }, 'That identity is already linked.')
    )
    mount()
    await fillForm()
    await fireEvent.click(screen.getByRole('button', { name: 'Link identity' }))
    expect((await screen.findByRole('alert')).textContent).toBe('That identity is already linked.')
    api.linkExternalIdentity.mockRejectedValueOnce(
      new ApiClientError(500, { code: 'db_exploded' }, 'internal detail')
    )
    await fireEvent.click(screen.getByRole('button', { name: 'Link identity' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('Failed to link identity.')
    )
    expect(byId('new-provider-name').value).toBe('corp.idp')
  })

  it('unlinks only after confirm, and shows a failure above the table', async () => {
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false)
    mount()
    const unlink = screen.getAllByRole('button', { name: 'Unlink' })
    await fireEvent.click(unlink[0] as HTMLElement)
    expect(api.unlinkExternalIdentity).not.toHaveBeenCalled()
    api.unlinkExternalIdentity.mockRejectedValue(new Error('boom'))
    await fireEvent.click(unlink[0] as HTMLElement)
    const alert = await screen.findByText('Failed to unlink identity.')
    expect(follows(alert, screen.getByRole('table'))).toBe(true)
    expect(screen.getAllByRole('row')).toHaveLength(3)
  })
})
