import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'

const gotoMock = vi.hoisted(() => vi.fn(async () => {}))
const mockedPage = vi.hoisted(() => ({
  data: { user: { orgRole: 'viewer', userId: 'u1' } } as { user?: Record<string, unknown> },
}))

vi.mock('$app/navigation', () => ({ goto: gotoMock }))
vi.mock('$app/state', () => ({ page: mockedPage }))

import GlobalSearch from './GlobalSearch.svelte'
import { clearRecents } from './palette-recents.js'
import {
  SEARCH_PROVIDERS_CONTEXT,
  createSearchProviderRegistry,
  type SearchProvider,
  type SearchProviderResult,
} from './search-providers.svelte.js'
import {
  credentialResult,
  installSearchFetchMock,
  projectResult,
  searchResponse,
} from './global-search-test-helpers.js'
import { path } from '$lib/navigation/nav-render-test-helpers.js'

const tenant: SearchProviderResult = {
  id: 't1',
  label: 'Acme Holdings',
  hint: 'Tenant',
  group: 'Tenants',
  href: path('/tenants/t1'),
}
const tenantAction: SearchProviderResult = {
  id: 't2',
  label: 'Switch to Beta',
  group: 'Tenants',
  action: vi.fn(),
}

function mountWith(providers: SearchProvider[]) {
  const registry = createSearchProviderRegistry()
  for (const provider of providers) registry.register(provider)
  const view = render(GlobalSearch, {
    props: { open: true },
    context: new Map([[SEARCH_PROVIDERS_CONTEXT, registry]]),
  })
  return { registry, view }
}

const typeQuery = (value: string) =>
  fireEvent.input(screen.getByLabelText('Search'), { target: { value } })

const optionTexts = () =>
  screen.queryAllByRole('option').map((o) => o.textContent?.replace(/\s+/g, ' ').trim() ?? '')

// The query is highlighted inside labels (`<mark>`), so rows are matched by their whole text.
const findOption = (text: string) =>
  vi.waitFor(
    () => {
      const found = optionTexts().find((t) => t.includes(text))
      if (!found) throw new Error(`no option with "${text}": ${optionTexts().join(' | ')}`)
      return found
    },
    { timeout: 2000 }
  )
const hasOption = (text: string) => optionTexts().some((t) => t.includes(text))

describe('GlobalSearch results providers (Story 72.18)', () => {
  beforeEach(() => {
    gotoMock.mockClear()
    clearRecents()
    installSearchFetchMock((url) =>
      String(url).startsWith('/api/v1/search')
        ? searchResponse([credentialResult, projectResult], 'acme')
        : searchResponse([])
    )
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('merges provider results after the native results, under the provider group', async () => {
    mountWith([{ id: 'cm', search: async () => [tenant] }])
    await typeQuery('acme')
    await findOption('Acme Holdings')
    const texts = optionTexts()
    expect(texts[0]).toContain('Stripe API Key')
    expect(texts[1]).toContain('Infra Core')
    expect(texts[2]).toContain('Acme Holdings')
    expect(screen.getByText('Tenants')).toBeTruthy()
    expect(screen.getByText('Tenant')).toBeTruthy()
  })

  it('passes the trimmed query to the provider with a signal', async () => {
    const search = vi.fn(async () => [tenant])
    mountWith([{ id: 'cm', search }])
    await typeQuery('  acme ')
    await findOption('Acme Holdings')
    expect(search).toHaveBeenCalledWith('acme', { signal: expect.any(AbortSignal) })
  })

  it('does not ask providers anything for an empty query', async () => {
    const search = vi.fn(async () => [tenant])
    mountWith([{ id: 'cm', search }])
    await typeQuery('   ')
    await new Promise((r) => setTimeout(r, 300))
    expect(search).not.toHaveBeenCalled()
  })

  it('keyboard selection reaches a provider result and navigates to its href', async () => {
    mountWith([{ id: 'cm', search: async () => [tenant] }])
    await typeQuery('acme')
    await findOption('Acme Holdings')
    const input = screen.getByLabelText('Search')
    await fireEvent.keyDown(input, { key: 'ArrowDown' })
    await fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')[2]?.getAttribute('aria-selected')).toBe('true')
    await fireEvent.keyDown(input, { key: 'Enter' })
    expect(gotoMock).toHaveBeenCalledWith('/tenants/t1')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a result with an action runs it and closes the palette', async () => {
    const action = vi.fn(async () => {})
    mountWith([{ id: 'cm', search: async () => [{ ...tenantAction, action }] }])
    await typeQuery('acme')
    await fireEvent.click(await screen.findByText('Switch to Beta', {}, { timeout: 2000 }))
    expect(action).toHaveBeenCalledTimes(1)
    expect(gotoMock).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('an action that fails keeps the palette open and says so calmly', async () => {
    const action = vi.fn(async () => {
      throw new Error('nope')
    })
    mountWith([{ id: 'cm', search: async () => [{ ...tenantAction, action }] }])
    await typeQuery('acme')
    await fireEvent.click(await screen.findByText('Switch to Beta', {}, { timeout: 2000 }))
    expect(await screen.findByText('That action could not be completed. Try again.')).toBeTruthy()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('a failing provider never breaks the palette: native results stay and a calm notice shows', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mountWith([
      {
        id: 'bad',
        search: async () => {
          throw new Error('boom')
        },
      },
    ])
    await typeQuery('acme')
    expect(await screen.findByText(/Infra Core/, {}, { timeout: 2000 })).toBeTruthy()
    expect(await screen.findByText('Some results could not be loaded.')).toBeTruthy()
    expect(screen.getByText('Stripe API Key')).toBeTruthy()
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('one failing provider does not hide the results of another', async () => {
    mountWith([
      {
        id: 'bad',
        search: async () => {
          throw new Error('boom')
        },
      },
      { id: 'cm', search: async () => [tenant] },
    ])
    await typeQuery('acme')
    await findOption('Acme Holdings')
    expect(await screen.findByText('Some results could not be loaded.')).toBeTruthy()
  })

  it('a provider that times out is surfaced as a failure while native results render', async () => {
    mountWith([{ id: 'slow', timeoutMs: 40, search: () => new Promise<never>(() => {}) }])
    await typeQuery('acme')
    expect(await screen.findByText(/Infra Core/, {}, { timeout: 2000 })).toBeTruthy()
    expect(
      await screen.findByText('Some results could not be loaded.', {}, { timeout: 2000 })
    ).toBeTruthy()
  })

  it('native results appear before a slow provider answers; late results then append', async () => {
    let release: (value: SearchProviderResult[]) => void = () => {}
    mountWith([
      {
        id: 'slow',
        search: () => new Promise<SearchProviderResult[]>((resolve) => (release = resolve)),
      },
    ])
    await typeQuery('acme')
    await screen.findByText(/Infra Core/, {}, { timeout: 2000 })
    expect(hasOption('Acme Holdings')).toBe(false)
    expect(screen.queryByText(/No results/)).toBeNull()
    release([tenant])
    await findOption('Acme Holdings')
    expect(optionTexts()[0]).toContain('Stripe API Key')
  })

  it('shows "No results" only when native and provider results are all empty', async () => {
    installSearchFetchMock(() => searchResponse([], 'zzz'))
    mountWith([{ id: 'cm', search: async () => [] }])
    await typeQuery('zzz')
    expect(await screen.findByText('No results for "zzz"', {}, { timeout: 2000 })).toBeTruthy()
  })

  it('does not say "No results" when only a provider has results', async () => {
    installSearchFetchMock(() => searchResponse([], 'acme'))
    mountWith([{ id: 'cm', search: async () => [tenant] }])
    await typeQuery('acme')
    await findOption('Acme Holdings')
    expect(screen.queryByText(/No results/)).toBeNull()
  })

  it('a provider registered after the palette opened is used by the next search', async () => {
    const { registry } = mountWith([])
    registry.register({ id: 'late', search: async () => [tenant] })
    await typeQuery('acme')
    expect(await findOption('Acme Holdings')).toContain('Acme Holdings')
  })

  it('an unregistered provider is no longer asked', async () => {
    const search = vi.fn(async () => [tenant])
    const { registry } = mountWith([])
    const unregister = registry.register({ id: 'cm', search })
    unregister()
    await typeQuery('acme')
    await screen.findByText(/Infra Core/, {}, { timeout: 2000 })
    expect(search).not.toHaveBeenCalled()
    expect(hasOption('Acme Holdings')).toBe(false)
  })

  it('renders provider text as text, never as markup', async () => {
    mountWith([
      {
        id: 'cm',
        search: async () => [
          { ...tenant, label: '<img src=x onerror=alert(1)>', hint: '<b>x</b>' },
        ],
      },
    ])
    await typeQuery('acme')
    expect(
      await screen.findByText('<img src=x onerror=alert(1)>', {}, { timeout: 2000 })
    ).toBeTruthy()
    expect(document.querySelector('img')).toBeNull()
  })

  it('without any provider the palette behaves as before', async () => {
    render(GlobalSearch, { props: { open: true } })
    await typeQuery('acme')
    expect(await screen.findByText(/Infra Core/, {}, { timeout: 2000 })).toBeTruthy()
    expect(screen.queryByText('Some results could not be loaded.')).toBeNull()
  })

  // Story 72.26: the previous provider rows stay until the new answer replaces them. The
  // proof is the held promises, not a clock: the second search has been asked, and the
  // first row is still in the list (and still the arrowed row) until that promise resolves.
  it('keeps the arrowed provider row until the next answer replaces it', async () => {
    const releases: Array<(rows: SearchProviderResult[]) => void> = []
    const search = vi.fn(
      () =>
        new Promise<SearchProviderResult[]>((resolve) => {
          releases.push(resolve)
        })
    )
    let releaseNative: (response: Response) => void = () => {}
    let nativeCalls = 0
    installSearchFetchMock((url) => {
      if (!String(url).startsWith('/api/v1/search')) return searchResponse([])
      nativeCalls += 1
      if (nativeCalls === 1) return searchResponse([credentialResult, projectResult], 'acme')
      return new Promise((resolve) => {
        releaseNative = resolve
      })
    })
    mountWith([{ id: 'cm', search }])
    await typeQuery('acme')
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1))
    const first = releases[0]
    if (!first) throw new Error('the first provider search never started')
    first([tenant])
    await findOption('Acme Holdings')

    const input = screen.getByLabelText('Search')
    await fireEvent.keyDown(input, { key: 'ArrowDown' })
    await fireEvent.keyDown(input, { key: 'ArrowDown' })
    const providerOption = () =>
      screen.getAllByRole('option').find((option) => option.textContent?.includes('Acme Holdings'))
    expect(providerOption()?.getAttribute('aria-selected')).toBe('true')

    await typeQuery('acme2')
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(2))
    expect(providerOption()?.getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByText(/No results/)).toBeNull()

    // Native rows shrink under the still-pending provider. The highlight follows the same row.
    releaseNative(searchResponse([credentialResult], 'acme2'))
    await vi.waitFor(() => {
      const options = screen.getAllByRole('option')
      if (options.some((option) => option.textContent?.includes('Infra Core'))) {
        throw new Error('the previous native project row is still showing')
      }
    })
    expect(providerOption()?.getAttribute('aria-selected')).toBe('true')
    expect(hasOption('Acme Holdings')).toBe(true)

    const second = releases[1]
    if (!second) throw new Error('the second provider search never started')
    second([{ ...tenant, id: 't9', label: 'Beta Tenant' }])
    await findOption('Beta Tenant')
    expect(hasOption('Acme Holdings')).toBe(false)
  })

  it('keeps the arrowed provider row when the next query inserts an action row above it', async () => {
    mockedPage.data = { user: { orgRole: 'owner', userId: 'u1' } }
    const releases: Array<(rows: SearchProviderResult[]) => void> = []
    const search = vi.fn(
      () =>
        new Promise<SearchProviderResult[]>((resolve) => {
          releases.push(resolve)
        })
    )
    mountWith([{ id: 'cm', search }])
    await typeQuery('acme')
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1))
    releases[0]?.([tenant])
    await findOption('Acme Holdings')
    const input = screen.getByLabelText('Search')
    await fireEvent.keyDown(input, { key: 'ArrowDown' })
    await fireEvent.keyDown(input, { key: 'ArrowDown' })
    const providerOption = () =>
      screen.getAllByRole('option').find((option) => option.textContent?.includes('Acme Holdings'))
    expect(providerOption()?.getAttribute('aria-selected')).toBe('true')

    // "c" matches "Create project", so an action row appears above the provider row immediately,
    // before the debounced search asks the provider. The highlight must stay on the same row.
    await typeQuery('c')
    await vi.waitFor(() => {
      expect(screen.getAllByRole('option')[0]?.textContent).toContain('Create project')
      expect(providerOption()?.getAttribute('aria-selected')).toBe('true')
    })
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(2))
    expect(providerOption()?.getAttribute('aria-selected')).toBe('true')
    mockedPage.data = { user: { orgRole: 'viewer', userId: 'u1' } }
  })

  it('replaces the previous provider row when the next answer is empty', async () => {
    let calls = 0
    const search = vi.fn(async () => {
      calls += 1
      return calls === 1 ? [tenant] : []
    })
    mountWith([{ id: 'cm', search }])
    await typeQuery('acme')
    await findOption('Acme Holdings')
    await typeQuery('acme2')
    await vi.waitFor(() => expect(calls).toBe(2))
    await vi.waitFor(() => {
      if (hasOption('Acme Holdings')) throw new Error('stale provider row still shown')
    })
    expect(screen.queryByText('Some results could not be loaded.')).toBeNull()
    expect(screen.getByText('Stripe API Key')).toBeTruthy()
  })

  it('drops a stale provider row only once the follow-up answer has failed', async () => {
    let rejectSecond: (reason: unknown) => void = () => {}
    let calls = 0
    const search = vi.fn(() => {
      calls += 1
      if (calls === 1) return Promise.resolve([tenant])
      return new Promise<SearchProviderResult[]>((_, reject) => {
        rejectSecond = reject
      })
    })
    mountWith([{ id: 'cm', search }])
    await typeQuery('acme')
    await findOption('Acme Holdings')
    await typeQuery('acme2')
    await vi.waitFor(() => expect(calls).toBe(2))
    expect(hasOption('Acme Holdings')).toBe(true)
    expect(screen.queryByText('Some results could not be loaded.')).toBeNull()

    rejectSecond(new Error('boom'))
    expect(await screen.findByText('Some results could not be loaded.')).toBeTruthy()
    expect(hasOption('Acme Holdings')).toBe(false)
    expect(screen.getByText('Stripe API Key')).toBeTruthy()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})
