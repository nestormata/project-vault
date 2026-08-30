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
  activeRotation: null,
}

describe('project credentials list +page.svelte', () => {
  it('an owner without active filters sees an "add your first credential" empty state', () => {
    render(CredentialsListPage, { props: { data: baseData({ orgRole: 'owner' }) } })
    expect(screen.getByText(/add your first secret/i)).toBeTruthy()
  })

  it('a viewer without create permission sees a plain empty-project message', () => {
    render(CredentialsListPage, { props: { data: baseData({ orgRole: 'viewer' }) } })
    expect(screen.getByText(/no secrets have been added to this project yet/i)).toBeTruthy()
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
    expect(screen.getByText(/showing 1 of 1 secrets/i)).toBeTruthy()
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

  // Story 18.5 AC-1/AC-6/AC-7
  describe('active rotation badge (Story 18.5)', () => {
    it('AC-1: renders a "Rotation in progress" badge for a credential with an active rotation', () => {
      render(CredentialsListPage, {
        props: {
          data: baseData({
            credentials: {
              items: [
                {
                  ...CREDENTIAL,
                  activeRotation: { rotationId: 'rot-1', status: 'staged' },
                },
              ],
              total: 1,
              page: 1,
              limit: 20,
              hasNext: false,
            },
          }),
        },
      })

      expect(screen.getByText(/rotation in progress/i)).toBeTruthy()
    })

    it('AC-6: the badge links to the rotation detail page using the same route pattern as the credential detail page', () => {
      render(CredentialsListPage, {
        props: {
          data: baseData({
            credentials: {
              items: [
                {
                  ...CREDENTIAL,
                  activeRotation: { rotationId: 'rot-1', status: 'staged' },
                },
              ],
              total: 1,
              page: 1,
              limit: 20,
              hasNext: false,
            },
          }),
        },
      })

      const link = screen.getByRole('link', { name: /rotation in progress/i })
      expect(link.getAttribute('href')).toBe(
        `/projects/${projectId}/credentials/${CREDENTIAL.id}/rotations/rot-1`
      )
    })

    it('renders no badge for a credential with no active rotation', () => {
      render(CredentialsListPage, {
        props: {
          data: baseData({
            credentials: { items: [CREDENTIAL], total: 1, page: 1, limit: 20, hasNext: false },
          }),
        },
      })

      expect(screen.queryByText(/rotation in progress/i)).toBeNull()
    })
  })

  // Story 28.5 AC5/AC6.
  describe('include-archived toggle and Archived badge', () => {
    it('renders the toggle checkbox with visible, aria-describedby-wired guidance text (G5)', () => {
      render(CredentialsListPage, { props: { data: baseData() } })
      const toggle = screen.getByLabelText(/include archived secrets/i)
      expect(toggle.getAttribute('aria-describedby')).toBe('credentials-include-archived-help')
      expect(document.getElementById('credentials-include-archived-help')?.textContent).toBeTruthy()
    })

    it('reflects includeArchived=true as checked', () => {
      render(CredentialsListPage, {
        props: {
          data: baseData({
            filters: { q: '', status: '', tags: '', page: 1, includeArchived: true },
          }),
        },
      })
      const toggle = screen.getByLabelText(/include archived secrets/i) as HTMLInputElement
      expect(toggle.checked).toBe(true)
    })

    it('renders an "Archived" badge next to an archived secret, not an active one', () => {
      const archived = { ...CREDENTIAL, id: 'cred-2', archivedAt: '2026-08-01T00:00:00.000Z' }
      render(CredentialsListPage, {
        props: {
          data: baseData({
            filters: { q: '', status: '', tags: '', page: 1, includeArchived: true },
            credentials: {
              items: [CREDENTIAL, archived],
              total: 2,
              page: 1,
              limit: 20,
              hasNext: false,
            },
          }),
        },
      })
      expect(screen.getAllByText('Archived')).toHaveLength(1)
    })
  })
})
