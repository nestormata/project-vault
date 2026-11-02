import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'

const gotoMock = vi.hoisted(() => vi.fn(async () => {}))
const mockedPage = vi.hoisted(() => ({
  data: {} as { user?: { orgRole: string; userId: string | null } },
}))

vi.mock('$app/navigation', () => ({ goto: gotoMock }))
vi.mock('$app/state', () => ({ page: mockedPage }))

import GlobalSearch from './GlobalSearch.svelte'
import {
  credentialResult,
  installSearchFetchMock,
  searchResponse,
} from './global-search-test-helpers.js'
import type { SearchResultItem } from '$lib/api/search.js'

const secondCredential: SearchResultItem = {
  ...credentialResult,
  id: 'cred-2',
  name: 'Other Key',
  snippet: 'Other Key snippet',
  projectName: 'Billing',
}

function countRegion(): HTMLElement {
  const region = document.getElementById('global-search-result-count')
  if (!region) throw new Error('missing result-count live region')
  return region
}

function selectedOption(): HTMLElement {
  const selected = screen
    .getAllByRole('option')
    .find((option) => option.getAttribute('aria-selected') === 'true')
  if (!selected) throw new Error('missing selected option')
  return selected
}

describe('GlobalSearch assistive technology', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    gotoMock.mockClear()
    vi.useRealTimers()
    mockedPage.data = {}
  })
  afterEach(() => cleanup())

  it('points aria-activedescendant at the selected row and gives every row its own id', async () => {
    installSearchFetchMock(() => searchResponse([credentialResult, secondCredential]))
    render(GlobalSearch, { props: { open: true } })
    await fireEvent.input(screen.getByLabelText('Search'), { target: { value: 'stripe' } })
    await vi.waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2))

    const input = screen.getByRole('combobox', { name: 'Search' })
    const options = screen.getAllByRole('option')
    const ids = options.map((option) => option.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => id.startsWith('global-search-option-'))).toBe(true)
    expect(input.getAttribute('aria-expanded')).toBe('true')
    expect(input.getAttribute('aria-activedescendant')).toBe(selectedOption().id)
    expect(input.getAttribute('aria-controls')).toBe('global-search-results')

    const dialog = screen.getByRole('dialog', { name: 'Global search' })
    await fireEvent.keyDown(dialog, { key: 'ArrowDown' })
    expect(input.getAttribute('aria-activedescendant')).toBe(selectedOption().id)
    expect(selectedOption().id).toBe(ids[1])
  })

  it('keeps a row id when that row moves in a later result set', async () => {
    installSearchFetchMock((url) => {
      const query = new URL(String(url), 'http://localhost').searchParams.get('q')
      const rows =
        query === 'second'
          ? [secondCredential, credentialResult]
          : [credentialResult, secondCredential]
      return searchResponse(rows, query ?? 'stripe')
    })
    render(GlobalSearch, { props: { open: true } })
    const input = screen.getByLabelText('Search')
    await fireEvent.input(input, { target: { value: 'first' } })
    await vi.waitFor(() => expect(screen.getByText('Stripe API Key')).toBeTruthy())
    const stripeId = screen.getByRole('option', { name: /Stripe API Key/ }).id
    expect(stripeId.startsWith('global-search-option-')).toBe(true)

    await fireEvent.input(input, { target: { value: 'second' } })
    await vi.waitFor(() =>
      expect(screen.getAllByRole('option')[0]?.textContent).toMatch(/Other Key/)
    )
    expect(screen.getByRole('option', { name: /Stripe API Key/ }).id).toBe(stripeId)
  })

  it('announces the navigable row count, including one result', async () => {
    installSearchFetchMock(() => searchResponse([credentialResult]))
    render(GlobalSearch, { props: { open: true } })
    expect(countRegion().getAttribute('aria-live')).toBe('polite')
    expect(countRegion().getAttribute('aria-atomic')).toBe('true')
    expect(countRegion().textContent?.trim()).toBe('')

    await fireEvent.input(screen.getByLabelText('Search'), { target: { value: 'stripe' } })
    await vi.waitFor(() => expect(countRegion().textContent?.trim()).toBe('1 result'))
    expect(screen.getAllByRole('status')).toHaveLength(1)
  })

  it('announces no results only after a settled query with nothing to arrow to', async () => {
    installSearchFetchMock(() => searchResponse([]))
    render(GlobalSearch, { props: { open: true } })
    await fireEvent.input(screen.getByLabelText('Search'), { target: { value: 'nomatch' } })
    await vi.waitFor(() => expect(countRegion().textContent?.trim()).toBe('No results'))
    expect(screen.getByText(/No results for "nomatch"/)).toBeTruthy()
    expect(
      screen.getByRole('combobox', { name: 'Search' }).hasAttribute('aria-activedescendant')
    ).toBe(false)
    expect(screen.getByRole('combobox', { name: 'Search' }).getAttribute('aria-expanded')).toBe(
      'false'
    )
  })

  it('does not announce no results while the search is still in flight', async () => {
    vi.useFakeTimers()
    let resolveFetch: (value: Response) => void = () => {}
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve
    })
    installSearchFetchMock(() => pending)
    render(GlobalSearch, { props: { open: true } })
    await fireEvent.input(screen.getByLabelText('Search'), { target: { value: 'stripe' } })
    await vi.advanceTimersByTimeAsync(200)
    expect(screen.getByText('Searching…')).toBeTruthy()
    expect(countRegion().textContent?.trim()).toBe('')
    resolveFetch(searchResponse([]))
    await vi.waitFor(() => expect(countRegion().textContent?.trim()).toBe('No results'))
  })

  it('counts the action rows an owner can arrow through before a query', async () => {
    mockedPage.data = { user: { orgRole: 'owner', userId: null } }
    installSearchFetchMock(() => searchResponse([]))
    render(GlobalSearch, { props: { open: true } })
    await vi.waitFor(() => expect(screen.getAllByRole('option').length).toBeGreaterThan(1))
    const count = screen.getAllByRole('option').length
    expect(countRegion().textContent?.trim()).toBe(`${count} results`)
    const input = screen.getByRole('combobox', { name: 'Search' })
    expect(input.getAttribute('aria-activedescendant')).toBe(selectedOption().id)
  })
})
