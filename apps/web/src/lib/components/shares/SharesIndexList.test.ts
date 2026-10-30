import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/svelte'
import { sampleShare } from '$lib/test/fixtures.js'
import type { ShareIndexItem } from '$lib/api/credential-shares.js'
import SharesIndexList from './SharesIndexList.svelte'
import { sharesIndexQuery } from './shares-index-query.js'

afterEach(cleanup)

function item(overrides: Partial<ShareIndexItem> = {}): ShareIndexItem {
  return {
    ...sampleShare(),
    credentialName: 'Stripe key',
    projectId: 'proj-1',
    projectName: 'Payments',
    ...overrides,
  }
}

const BASE = { total: 1, page: 1, pageSize: 25, displayStatus: null } as const

describe('SharesIndexList (Story 72.11 AC1/AC2)', () => {
  it('lists credential link, recipient, dates and the display status badge', () => {
    render(SharesIndexList, {
      props: {
        ...BASE,
        items: [
          item({
            id: 'a',
            recipientType: 'external',
            recipientEmail: 'vendor@example',
            displayStatus: 'locked',
          }),
        ],
      },
    })
    const link = screen.getByRole('link', { name: 'Stripe key' })
    expect(link.getAttribute('href')).toBe('/projects/proj-1/credentials/credential-1')
    expect(screen.getByText('vendor@example (external)')).toBeTruthy()
    const row = screen.getByRole('listitem')
    expect(within(row).getByText('Locked').className).toContain('text-red-900')
    expect(screen.getByText('Showing 1 to 1 of 1')).toBeTruthy()
  })

  it('renders every display status with its own label', () => {
    render(SharesIndexList, {
      props: {
        ...BASE,
        total: 6,
        items: (['active', 'opened', 'locked', 'revoked', 'expired', 'superseded'] as const).map(
          (displayStatus) => item({ id: displayStatus, displayStatus })
        ),
      },
    })
    for (const label of ['Active', 'Opened', 'Locked', 'Revoked', 'Expired', 'Superseded']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
  })

  it('marks the selected filter chip as the current page and links the others', () => {
    render(SharesIndexList, { props: { ...BASE, items: [item()], displayStatus: 'opened' } })
    const nav = screen.getByRole('navigation', { name: 'Filter by status' })
    const opened = within(nav).getByRole('link', { name: 'Opened' })
    expect(opened.getAttribute('aria-current')).toBe('page')
    expect(within(nav).getByRole('link', { name: 'All' }).getAttribute('aria-current')).toBeNull()
    expect(within(nav).getByRole('link', { name: 'Locked' }).getAttribute('href')).toBe(
      '/shares?displayStatus=locked'
    )
    expect(within(nav).getByRole('link', { name: 'All' }).getAttribute('href')).toBe('/shares')
  })

  it('shows the empty state and no pagination for an empty list', () => {
    render(SharesIndexList, { props: { ...BASE, total: 0, items: [] } })
    expect(screen.getByText('No shares match this filter.')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Next' })).toBeNull()
  })

  it('links Previous and Next with the filter kept', () => {
    render(SharesIndexList, {
      props: {
        items: [item()],
        total: 80,
        page: 2,
        pageSize: 25,
        displayStatus: 'active',
      },
    })
    expect(screen.getByRole('link', { name: 'Previous' }).getAttribute('href')).toBe(
      '/shares?displayStatus=active'
    )
    expect(screen.getByRole('link', { name: 'Next' }).getAttribute('href')).toBe(
      '/shares?displayStatus=active&page=3'
    )
    expect(screen.getByText('Showing 26 to 26 of 80')).toBeTruthy()
  })

  it('has no Next link on the last page', () => {
    render(SharesIndexList, {
      props: { items: [item()], total: 26, page: 2, pageSize: 25, displayStatus: null },
    })
    expect(screen.queryByRole('link', { name: 'Next' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Previous' }).getAttribute('href')).toBe('/shares')
  })
})

describe('sharesIndexQuery', () => {
  it('is empty for All on page 1 and carries filter and page otherwise', () => {
    expect(sharesIndexQuery(null, 1)).toBe('')
    expect(sharesIndexQuery('locked', 1)).toBe('?displayStatus=locked')
    expect(sharesIndexQuery(null, 4)).toBe('?page=4')
    expect(sharesIndexQuery('expired', 2)).toBe('?displayStatus=expired&page=2')
  })
})
