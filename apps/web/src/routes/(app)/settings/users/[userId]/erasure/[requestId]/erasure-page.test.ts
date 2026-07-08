import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { routeExists } from '$lib/test/route-exists.js'

const invalidateAllMock = vi.hoisted(() => vi.fn(async () => {}))
const executeErasureMock = vi.hoisted(() => vi.fn())
const triggerJsonDownloadMock = vi.hoisted(() => vi.fn())

vi.mock('$app/navigation', () => ({ invalidateAll: invalidateAllMock }))

vi.mock('$lib/api/compliance.js', () => ({
  executeErasure: executeErasureMock,
}))

vi.mock('$lib/download.js', () => ({
  triggerJsonDownload: triggerJsonDownloadMock,
}))

import { ApiClientError } from '$lib/api/client.js'
import ErasurePage from './+page.svelte'

const userId = 'u-1'
const requestId = 'req-1'
const userEmail = 'contractor@example.com'

beforeEach(() => {
  invalidateAllMock.mockReset()
  executeErasureMock.mockReset()
  triggerJsonDownloadMock.mockReset()
})

afterEach(() => cleanup())

const PII_INVENTORY = {
  tables: [
    { table: 'users', rowCount: 1, piiFields: ['email', 'passwordHash'] },
    { table: 'sessions', rowCount: 3, piiFields: ['ipAddress', 'userAgent'] },
  ],
}

const COMPLETED_REPORT = {
  requestId,
  executedAt: '2026-07-07T00:00:00.000Z',
  piiRemoved: [{ table: 'sessions', fields: ['ipAddress', 'userAgent'], method: 'nulled' }],
  piiRetained: [
    { table: 'audit_log_entries', reason: 'audit log integrity (HMAC-protected, append-only)' },
  ],
  retentionJustification: 'Legal hold under SOC 2 requirements',
  auditEventId: 'evt-1',
}

function baseData(overrides: Record<string, unknown> = {}) {
  return {
    orgRole: 'admin',
    userId,
    requestId,
    state: 'pending' as const,
    piiInventory: PII_INVENTORY,
    userEmail,
    ...overrides,
  }
}

describe('/settings/users/[userId]/erasure/[requestId] +page.svelte (AC groups K/L/M)', () => {
  it('AC-K1: renders the PII inventory table before any erasure happens', () => {
    render(ErasurePage, { props: { data: baseData() } })

    expect(screen.getByText('users')).toBeTruthy()
    expect(screen.getByText(/email, passwordHash/)).toBeTruthy()
    expect(screen.getByText('sessions')).toBeTruthy()
  })

  it('AC-L2: an admin (not owner) sees the inventory but no Execute erasure control', () => {
    render(ErasurePage, { props: { data: baseData({ orgRole: 'admin' }) } })

    expect(screen.queryByRole('button', { name: /execute erasure/i })).toBeNull()
    expect(screen.getByText(/only an organization owner can execute/i)).toBeTruthy()
  })

  it('AC-L1: an owner can type the exact email to enable Execute erasure, then confirm twice (two-step)', async () => {
    executeErasureMock.mockResolvedValue({
      requestId,
      status: 'completed',
      completedAt: '2026-07-07T00:00:00.000Z',
      revokedSessionCount: 2,
      auditEventId: 'evt-1',
    })

    render(ErasurePage, { props: { data: baseData({ orgRole: 'owner' }) } })

    const executeButton = screen.getByRole('button', {
      name: /^execute erasure$/i,
    }) as HTMLButtonElement
    expect(executeButton.disabled).toBe(true)

    await fireEvent.input(screen.getByLabelText(/type the exact email/i), {
      target: { value: userEmail },
    })
    expect(
      (screen.getByRole('button', { name: /^execute erasure$/i }) as HTMLButtonElement).disabled
    ).toBe(false)

    await fireEvent.click(screen.getByRole('button', { name: /^execute erasure$/i }))
    expect(executeErasureMock).not.toHaveBeenCalled()

    await fireEvent.click(screen.getByRole('button', { name: /confirm/i }))

    expect(executeErasureMock).toHaveBeenCalledWith(expect.anything(), userId, requestId)
    expect(invalidateAllMock).toHaveBeenCalled()
  })

  it('AC-L3: a 409 user_has_other_org_memberships shows the exact remediation, stays on the pending screen', async () => {
    executeErasureMock.mockRejectedValue(
      new ApiClientError(
        409,
        {
          code: 'user_has_other_org_memberships',
          message: 'blocked',
          otherOrgCount: 1,
          remediation:
            "Contact support to coordinate removal of this user's membership in the other org(s) before erasure can proceed.",
        },
        'blocked'
      )
    )

    render(ErasurePage, { props: { data: baseData({ orgRole: 'owner' }) } })
    await fireEvent.input(screen.getByLabelText(/type the exact email/i), {
      target: { value: userEmail },
    })
    await fireEvent.click(screen.getByRole('button', { name: /^execute erasure$/i }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm/i }))

    expect(
      await screen.findByText(/contact support to coordinate removal of this user's membership/i)
    ).toBeTruthy()
    expect(screen.getByText('PII Inventory')).toBeTruthy() // still on the pending review screen
  })

  it('AC-L4: a 409 erasure_already_in_progress offers a refresh control, not a resubmit-prone retry', async () => {
    executeErasureMock.mockRejectedValue(
      new ApiClientError(
        409,
        { code: 'erasure_already_in_progress', message: 'in progress' },
        'in progress'
      )
    )

    render(ErasurePage, { props: { data: baseData({ orgRole: 'owner' }) } })
    await fireEvent.input(screen.getByLabelText(/type the exact email/i), {
      target: { value: userEmail },
    })
    await fireEvent.click(screen.getByRole('button', { name: /^execute erasure$/i }))
    await fireEvent.click(screen.getByRole('button', { name: /confirm/i }))

    expect(await screen.findByText(/already being processed/i)).toBeTruthy()
  })

  it('state=in_progress: shows a "currently being processed" notice', () => {
    render(ErasurePage, {
      props: { data: baseData({ state: 'in_progress', piiInventory: undefined }) },
    })
    expect(screen.getByText(/currently being processed/i)).toBeTruthy()
  })

  it('state=not_found: shows a "not found" notice with a link back to /settings/users', () => {
    render(ErasurePage, {
      props: { data: baseData({ state: 'not_found', piiInventory: undefined }) },
    })
    const link = screen.getByRole('link', { name: /settings.*users|back/i })
    expect(link.getAttribute('href')).toBe('/settings/users')
    expect(routeExists(link.getAttribute('href') ?? '')).toBe(true)
  })

  it('AC-M1: state=completed renders piiRemoved/piiRetained/retentionJustification/auditEventId in the exact response shape', () => {
    render(ErasurePage, {
      props: {
        data: baseData({ state: 'completed', report: COMPLETED_REPORT, piiInventory: undefined }),
      },
    })

    expect(screen.getByText(/sessions.*ipAddress, userAgent.*nulled/)).toBeTruthy()
    expect(screen.getByText(/audit_log_entries.*audit log integrity/)).toBeTruthy()
    expect(screen.getByText(/Legal hold under SOC 2 requirements/)).toBeTruthy()
    expect(screen.getByText(/evt-1/)).toBeTruthy()
  })

  it('AC-M2: clicking Download compliance report triggers a JSON download of the exact report data', async () => {
    render(ErasurePage, {
      props: {
        data: baseData({ state: 'completed', report: COMPLETED_REPORT, piiInventory: undefined }),
      },
    })

    await fireEvent.click(screen.getByRole('button', { name: /download compliance report/i }))

    expect(triggerJsonDownloadMock).toHaveBeenCalledWith(
      `erasure-report-${requestId}.json`,
      COMPLETED_REPORT
    )
  })
})
