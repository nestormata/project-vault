import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import CredentialsListPage from './+page.svelte'

afterEach(() => cleanup())

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function baseData(overrides: Record<string, unknown> = {}) {
  return {
    projectId,
    orgRole: 'owner',
    filters: { q: '', status: '', tags: '', page: 1 },
    credentials: { items: [], total: 0, page: 1, limit: 20, hasNext: false },
    ...overrides,
  }
}

const CREDENTIAL = {
  id: 'cred-1',
  name: 'Stripe Secret Key',
  status: 'active' as const,
  tags: ['payments', 'prod'],
  expiresAt: '2026-08-01T00:00:00.000Z',
  hasDependencies: true,
}

describe('project credentials list +page.svelte', () => {
  it('an owner without active filters sees an "add your first credential" empty state', () => {
    render(CredentialsListPage, { props: { data: baseData({ orgRole: 'owner' }) } })
    expect(screen.getByText(/add your first credential/i)).toBeTruthy()
  })

  it('a viewer without create permission sees a plain empty-project message', () => {
    render(CredentialsListPage, { props: { data: baseData({ orgRole: 'viewer' }) } })
    expect(screen.getByText(/no credentials have been added to this project yet/i)).toBeTruthy()
  })

  it('an active filter with no results shows "try adjusting your filters" and a Clear link', () => {
    render(CredentialsListPage, {
      props: { data: baseData({ filters: { q: 'nomatch', status: '', tags: '', page: 1 } }) },
    })
    expect(screen.getByText(/try adjusting your filters/i)).toBeTruthy()
    expect(screen.getByRole('link', { name: /clear/i })).toBeTruthy()
  })

  it('with no filters set, no Clear link is shown', () => {
    render(CredentialsListPage, { props: { data: baseData() } })
    expect(screen.queryByRole('link', { name: /clear/i })).toBeNull()
  })

  it('renders a populated table row with tags joined and a dependencies marker', () => {
    render(CredentialsListPage, {
      props: {
        data: baseData({
          credentials: { items: [CREDENTIAL], total: 1, page: 1, limit: 20, hasNext: false },
        }),
      },
    })

    expect(screen.getByText('Stripe Secret Key')).toBeTruthy()
    expect(screen.getByText('payments, prod')).toBeTruthy()
    expect(screen.getByText('Yes')).toBeTruthy()
    expect(screen.getByText(/showing 1 of 1 credentials/i)).toBeTruthy()
  })

  it('renders a dash for credentials with no tags and no dependencies', () => {
    render(CredentialsListPage, {
      props: {
        data: baseData({
          credentials: {
            items: [{ ...CREDENTIAL, tags: [], hasDependencies: false, expiresAt: null }],
            total: 1,
            page: 1,
            limit: 20,
            hasNext: false,
          },
        }),
      },
    })

    // Two dashes: tags column and dependencies column (expiresAt also renders a dash).
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2)
  })

  it('renders distinct status pill classes for expiring and expired credentials', () => {
    render(CredentialsListPage, {
      props: {
        data: baseData({
          credentials: {
            items: [
              { ...CREDENTIAL, id: 'c2', status: 'expiring' },
              { ...CREDENTIAL, id: 'c3', status: 'expired' },
            ],
            total: 2,
            page: 1,
            limit: 20,
            hasNext: false,
          },
        }),
      },
    })

    expect(screen.getByText('expiring')).toBeTruthy()
    expect(screen.getByText('expired')).toBeTruthy()
  })
})
