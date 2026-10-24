import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'

// Story 69.11: the platform organizations page is the list and the create form, each a sub-region.
// A probe contribution lands after its own section, and the create controller owns the form state
// and hands the refreshed list back to the list region.

const api = vi.hoisted(() => ({ createOrg: vi.fn(), listOrgs: vi.fn() }))
vi.mock('$app/state', () => ({
  page: { route: { id: '/(app)/platform/settings/orgs' }, params: {} },
}))
vi.mock('$lib/api/platform.js', () => ({ createOrg: api.createOrg, listOrgs: api.listOrgs }))

const POINTS = [
  'platform.settings-orgs.list',
  'platform.settings-orgs.create-status',
  'platform.settings-orgs.create-form',
] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))
const ORGS = [
  {
    id: 'o1',
    name: 'Acme Corp',
    slug: 'acme',
    createdAt: '2026-09-01T10:00:00.000Z',
    memberCount: 4,
  },
]

let Content: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Content = (await import('./PlatformOrgsContent.svelte')).default as unknown as typeof Content
}, 60_000)
beforeEach(() => {
  api.createOrg.mockReset()
  api.listOrgs.mockReset()
})
afterEach(cleanup)

const mount = (pageData: Record<string, unknown> = {}) =>
  render(Content, {
    props: {
      pageData: { allowed: true, orgs: ORGS, errorMessage: null, ...pageData },
      data: fills,
    },
  })
const probe = (point: string): HTMLElement => {
  const found = screen
    .getAllByTestId('probe')
    .find((el) => el.textContent?.includes(`"fill:${point}"`))
  if (found === undefined) throw new Error(`no probe for ${point}`)
  return found
}
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
const fillForm = async () => {
  await fireEvent.input(screen.getByLabelText(/Organization name/), { target: { value: ' Beta ' } })
  await fireEvent.input(screen.getByLabelText(/Owner email/), {
    target: { value: ' owner@beta.io ' },
  })
}
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Create organization' }))

describe('PlatformOrgsContent sub-regions (probe order)', () => {
  it('list: after the table; create-status: after the heading; create-form: after the button', () => {
    mount()
    const list = probe('platform.settings-orgs.list')
    const status = probe('platform.settings-orgs.create-status')
    const form = probe('platform.settings-orgs.create-form')
    expect(follows(screen.getByRole('table'), list)).toBe(true)
    expect(follows(list, screen.getByRole('heading', { name: 'Create organization' }))).toBe(true)
    expect(follows(screen.getByRole('heading', { name: 'Create organization' }), status)).toBe(true)
    expect(follows(status, screen.getByLabelText(/Organization name/))).toBe(true)
    expect(follows(screen.getByRole('button', { name: 'Create organization' }), form)).toBe(true)
  })

  it('list: still rendered after the empty notice when there are no organizations', () => {
    mount({ orgs: [] })
    expect(
      follows(screen.getByText('No organizations found.'), probe('platform.settings-orgs.list'))
    ).toBe(true)
  })
})

describe('PlatformOrgsContent create form state (interaction)', () => {
  it('creates, announces the invitation, clears the form and shows the refreshed list', async () => {
    api.createOrg.mockResolvedValue({ name: 'Beta', ownerAccountAction: 'invited' })
    api.listOrgs.mockResolvedValue({
      items: [...ORGS, { ...ORGS[0], id: 'o2', name: 'Beta', slug: 'beta' }],
    })
    mount()
    await fillForm()
    await submit()
    await waitFor(() =>
      expect(api.createOrg).toHaveBeenCalledWith(fetch, {
        name: 'Beta',
        ownerEmail: 'owner@beta.io',
      })
    )
    expect(await screen.findByRole('status')).toBeTruthy()
    expect(screen.getByRole('status').textContent?.trim()).toBe(
      'Organization "Beta" created. An invitation was sent to owner@beta.io.'
    )
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3))
    expect((screen.getByLabelText(/Organization name/) as HTMLInputElement).value).toBe('')
  })

  it('says the owner was added when the account already existed', async () => {
    api.createOrg.mockResolvedValue({ name: 'Beta', ownerAccountAction: 'existing_user_added' })
    api.listOrgs.mockResolvedValue({ items: ORGS })
    mount()
    await fillForm()
    await submit()
    expect((await screen.findByRole('status')).textContent?.trim()).toBe(
      'Organization "Beta" created. owner@beta.io was added as owner (existing account).'
    )
  })

  it('shows a taken name next to the name field and keeps what was typed', async () => {
    api.createOrg.mockRejectedValue(
      new ApiClientError(409, { code: 'org_name_taken' }, 'Name already taken.')
    )
    mount()
    await fillForm()
    await submit()
    const nameError = await screen.findByText('Name already taken.')
    expect(nameError.closest('label')?.textContent).toContain('Organization name')
    expect((screen.getByLabelText(/Owner email/) as HTMLInputElement).value).toBe('owner@beta.io')
  })

  it('links to the settings when the instance reached its organization limit', async () => {
    api.createOrg.mockRejectedValue(
      new ApiClientError(409, { code: 'max_orgs_reached' }, 'You reached the maximum.')
    )
    mount()
    await fillForm()
    await submit()
    expect((await screen.findByRole('alert')).textContent).toContain('You reached the maximum.')
    expect(screen.getByRole('link', { name: '→ Settings' }).getAttribute('href')).toBe(
      '/platform/settings'
    )
  })

  it('explains a sealed vault on a bare 503 status body', async () => {
    api.createOrg.mockRejectedValue(new ApiClientError(503, { status: 'sealed' } as never, 'x'))
    mount()
    await fillForm()
    await submit()
    expect((await screen.findByRole('alert')).textContent?.trim()).toBe(
      'The vault was sealed while you were on this page — unseal it to continue.'
    )
  })

  it('routes an MFA requirement to the MFA-aware alert with its enable link', async () => {
    api.createOrg.mockRejectedValue(
      new ApiClientError(403, { code: 'mfa_required' }, 'MFA is required for this action.')
    )
    mount()
    await fillForm()
    await submit()
    expect(await screen.findByRole('link', { name: 'Enable MFA' })).toBeTruthy()
  })
})
