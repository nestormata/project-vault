// Story 72.18 AC-3: a fill rendered inside the layout's search region registers a results provider
// by name through context (no hard import of the palette), and the palette shows its results.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'

const gotoMock = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('$app/navigation', () => ({ goto: gotoMock }))
vi.mock('$app/state', () => ({ page: { data: { user: { orgRole: 'viewer', userId: 'u1' } } } }))

import { path } from '$lib/navigation/nav-render-test-helpers.js'
import SearchProviderFill from '$lib/test/SearchProviderFill.test.svelte'
import SearchProviderHarness from '$lib/test/SearchProviderHarness.test.svelte'
import GlobalSearch from './GlobalSearch.svelte'
import { installSearchFetchMock, searchResponse } from './global-search-test-helpers.js'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  gotoMock.mockClear()
})

describe('AppLayoutSearch provider registration (Story 72.18)', () => {
  it('a fill inside the region registers a provider; selecting its result navigates', async () => {
    installSearchFetchMock(() => searchResponse([], 'beta'))
    render(SearchProviderHarness, {
      props: {
        provider: {
          id: 'cm',
          search: async () => [
            { id: 'g1', label: 'Beta group', group: 'Groups', href: path('/groups/1') },
          ],
        },
      },
    })
    await fireEvent.input(screen.getByLabelText('Search'), { target: { value: 'zzz' } })
    const row = await screen.findByText('Beta group', {}, { timeout: 2000 })
    expect(screen.getByText('Groups')).toBeTruthy()
    await fireEvent.click(row)
    expect(gotoMock).toHaveBeenCalledWith('/groups/1')
  })

  it('unmounting the fill unregisters the provider', async () => {
    installSearchFetchMock(() => searchResponse([], 'beta'))
    const search = vi.fn(async () => [])
    const view = render(SearchProviderHarness, { props: { provider: { id: 'cm', search } } })
    view.unmount()
    render(GlobalSearch, { props: { open: true } })
    await fireEvent.input(screen.getByLabelText('Search'), { target: { value: 'zzz' } })
    await screen.findByText(/No results/, {}, { timeout: 2000 })
    expect(search).not.toHaveBeenCalled()
  })

  it('a fill with no palette around it registers nothing and does not throw', () => {
    const search = vi.fn(async () => [])
    expect(() =>
      render(SearchProviderFill, { props: { provider: { id: 'cm', search } } })
    ).not.toThrow()
    expect(search).not.toHaveBeenCalled()
  })
})
