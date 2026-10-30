import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/svelte'
import type { AttentionItem, DashboardAttention } from '@project-vault/shared'
import { setLocale } from '$lib/paraglide/runtime.js'
import DashboardAttentionList from './DashboardAttentionList.svelte'

const MAIL_DOMAIN = 'team.test'

afterEach(async () => {
  cleanup()
  await setLocale('en', { reload: false })
})

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const PROJECT = uuid(1)
const base = { projectId: PROJECT, projectName: 'Payments', dueAt: '2026-11-05T12:00:00.000Z' }

const share: AttentionItem = {
  ...base,
  kind: 'expiring_share',
  id: uuid(10),
  credentialId: uuid(11),
  credentialName: 'Stripe key',
  recipientEmail: `guest@${MAIL_DOMAIN}`,
}
const certificate: AttentionItem = {
  ...base,
  kind: 'expiring_certificate',
  id: uuid(20),
  domain: 'pay.example.com',
  expired: false,
}
const expiredCertificate: AttentionItem = { ...certificate, id: uuid(21), expired: true }
const invitation: AttentionItem = {
  ...base,
  kind: 'pending_invitation',
  id: uuid(30),
  email: `new@${MAIL_DOMAIN}`,
  roleToAssign: 'member',
}

const counts = (items: AttentionItem[]): DashboardAttention['counts'] => ({
  expiringShares: items.filter((i) => i.kind === 'expiring_share').length,
  expiringCertificates: items.filter((i) => i.kind === 'expiring_certificate').length,
  pendingInvitations: items.filter((i) => i.kind === 'pending_invitation').length,
})

function ready(items: AttentionItem[], over: Partial<DashboardAttention['counts']> = {}) {
  return { status: 'ready' as const, items, counts: { ...counts(items), ...over } }
}

describe('DashboardAttentionList.svelte (story 72-12)', () => {
  it('renders nothing at all for an error, a missing read and an empty list', () => {
    for (const attention of [{ status: 'error' as const }, undefined, ready([])]) {
      const { container } = render(DashboardAttentionList, { props: { attention } })
      expect(container.querySelector('*')).toBeNull()
      expect(container.textContent).toBe('')
      cleanup()
    }
  })

  it('renders a labelled list with one row and exactly one link per item', () => {
    render(DashboardAttentionList, {
      props: { attention: ready([share, certificate, invitation]) },
    })
    const heading = screen.getByRole('heading', { name: 'Needs attention' })
    const list = screen.getByRole('list', { name: 'Needs attention' })
    expect(heading).toBeTruthy()
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    const hrefs = rows.map((row) => {
      const links = within(row).getAllByRole('link')
      expect(links).toHaveLength(1)
      return links[0]?.getAttribute('href')
    })
    expect(hrefs).toEqual([
      `/projects/${PROJECT}/credentials/${uuid(11)}`,
      `/projects/${PROJECT}/certificates`,
      `/projects/${PROJECT}/members`,
    ])
    expect(rows[0]?.textContent).toContain('Stripe key')
    expect(rows[0]?.textContent).toContain(`guest@${MAIL_DOMAIN}`)
    expect(rows[1]?.textContent).toContain('pay.example.com')
    expect(rows[2]?.textContent).toContain(`new@${MAIL_DOMAIN}`)
  })

  it('flags an expired certificate and words a share without an e-mail', () => {
    render(DashboardAttentionList, {
      props: { attention: ready([expiredCertificate, { ...share, recipientEmail: null }]) },
    })
    expect(screen.getByText('Expired')).toBeTruthy()
    expect(screen.getByText(/has expired/)).toBeTruthy()
    expect(screen.getByText(/A share of Stripe key in Payments/)).toBeTruthy()
  })

  it('says "and N more" when the true totals exceed the rows shown', () => {
    render(DashboardAttentionList, {
      props: { attention: ready([certificate, invitation], { expiringCertificates: 6 }) },
    })
    expect(screen.getByText('and 5 more')).toBeTruthy()
  })

  it('shows no overflow line when everything is shown', () => {
    render(DashboardAttentionList, { props: { attention: ready([certificate]) } })
    expect(screen.queryByText(/more$/)).toBeNull()
  })

  it('speaks Spanish', async () => {
    await setLocale('es', { reload: false })
    render(DashboardAttentionList, {
      props: { attention: ready([expiredCertificate], { expiringCertificates: 3 }) },
    })
    expect(screen.getByRole('heading', { name: 'Requiere atención' })).toBeTruthy()
    expect(screen.getByText('Vencido')).toBeTruthy()
    expect(screen.getByText('y 2 más')).toBeTruthy()
  })
})
