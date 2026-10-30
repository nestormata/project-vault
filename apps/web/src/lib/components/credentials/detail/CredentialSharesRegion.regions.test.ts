import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'
import { credentialPointExtras } from '$lib/credentials/credential-detail-helpers.js'
import { sampleCredential, sampleProject, sampleShare } from '$lib/test/fixtures.js'

// Story 72.11: the Shares section's display status badges, localized typed-reason errors, and the
// new `credential.detail.shares.field-help` point next to the field scope selector.

const createExternalMock = vi.hoisted(() => vi.fn())
const createMemberMock = vi.hoisted(() => vi.fn())
const revokeMock = vi.hoisted(() => vi.fn())
vi.mock('$app/state', () => ({
  page: {
    route: { id: '/(app)/projects/[projectId]/credentials/[credentialId]' },
    params: {},
  },
}))
vi.mock('$lib/api/credential-shares.js', () => ({
  createExternalCredentialShare: createExternalMock,
  createCredentialShare: createMemberMock,
  revokeCredentialShare: revokeMock,
}))

const POINT = 'credential.detail.shares.field-help'
const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const credentialId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const CREDENTIAL = sampleCredential({
  id: credentialId,
  projectId,
  fields: [{ key: 'host', sensitive: false }],
})

let Region: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  vi.doMock(`virtual:pv-inject/${POINT}`, () => ({
    default: [{ id: `${POINT}#0`, order: 0, component: probe }],
  }))
  Region = (await import('./CredentialSharesRegion.svelte')).default as unknown as typeof Region
}, 60_000)
beforeEach(() => {
  for (const mock of [createExternalMock, createMemberMock, revokeMock]) mock.mockReset()
})
afterEach(cleanup)

function mount(shares = [sampleShare()]) {
  const base = {
    credential: CREDENTIAL,
    projectId,
    credentialId,
    orgRole: 'member' as const,
    project: sampleProject({ id: projectId, role: 'member' }),
  }
  render(Region, {
    props: {
      ...base,
      origin: 'http://localhost',
      shares,
      sharesTotal: shares.length,
      sharesPage: 1,
      sharesStatus: null,
      orgMembers: [],
      pointProps: credentialPointExtras(base),
      data: { [POINT]: [{ marker: `fill:${POINT}` }] },
    },
  })
}

describe('Shares region (Story 72.11)', () => {
  it('shows the display status, so an opened or locked share is not just "viewed" or "revoked"', () => {
    mount([
      sampleShare({ id: 's1', displayStatus: 'opened', status: 'active', viewCount: 1 }),
      sampleShare({ id: 's2', displayStatus: 'locked', status: 'revoked' }),
    ])
    const rows = screen.getAllByRole('listitem')
    expect(within(rows[0] as HTMLElement).getByText('Opened')).toBeTruthy()
    expect(within(rows[1] as HTMLElement).getByText('Locked')).toBeTruthy()
    // A locked share is closed: no Revoke action.
    expect(within(rows[1] as HTMLElement).queryByRole('button', { name: /revoke/i })).toBeNull()
  })

  it('renders the field-help point inside the "Fields to share" group, with the credential as prop', () => {
    mount()
    const group = screen.getByRole('group', { name: 'Fields to share' })
    const found = within(group)
      .getAllByTestId('probe')
      .find((el) => el.textContent?.includes(`"fill:${POINT}"`))
    expect(found).toBeTruthy()
    expect(found?.textContent).not.toMatch(/token|password|totp/i)
  })

  it('maps a typed reason of a failed external share to its localized message', async () => {
    createExternalMock.mockRejectedValue(
      new ApiClientError(
        429,
        {
          code: 'external_share_cap_exceeded',
          reason: 'external_cap_reached',
          message: 'raw api text',
        },
        'raw api text'
      )
    )
    mount()
    await fireEvent.click(screen.getByRole('button', { name: 'External (email)' }))
    await fireEvent.input(screen.getByPlaceholderText('vendor@invalid'), {
      target: { value: 'vendor@example' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Create share link' }))
    expect(await screen.findByText(/Too many external shares are waiting/)).toBeTruthy()
    expect(screen.queryByText('raw api text')).toBeNull()
  })

  it('keeps the raw API message for an error without a reason', async () => {
    createExternalMock.mockRejectedValue(new ApiClientError(500, null, 'raw api text'))
    mount()
    await fireEvent.click(screen.getByRole('button', { name: 'External (email)' }))
    await fireEvent.input(screen.getByPlaceholderText('vendor@invalid'), {
      target: { value: 'vendor@example' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Create share link' }))
    expect(await screen.findByText('raw api text')).toBeTruthy()
  })

  it('maps a typed reason of a failed revoke', async () => {
    revokeMock.mockRejectedValue(
      new ApiClientError(
        403,
        { code: 'insufficient_role', reason: 'revoke_forbidden' },
        'Forbidden'
      )
    )
    mount()
    await fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    expect(await screen.findByText(/Only the person who shared this/)).toBeTruthy()
  })
})
