import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte'

const gotoMock = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('$app/navigation', () => ({
  goto: gotoMock,
}))

import GlobalSearch from './GlobalSearch.svelte'
import {
  credentialResult,
  installSearchFetchMock,
  projectResult,
  searchResponse,
} from './global-search-test-helpers.js'

function pressShortcut(meta = true) {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'k', metaKey: meta, ctrlKey: !meta, bubbles: true })
  )
}

describe('GlobalSearch', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    gotoMock.mockClear()
    vi.useRealTimers()
  })
  afterEach(() => cleanup())

  it('opens when Cmd+K is pressed', async () => {
    render(GlobalSearch, { props: { open: false } })
    pressShortcut(true)
    expect(await screen.findByRole('dialog', { name: 'Global search' })).toBeTruthy()
  })

  it('opens when Ctrl+K is pressed', async () => {
    render(GlobalSearch, { props: { open: false } })
    pressShortcut(false)
    expect(await screen.findByRole('dialog', { name: 'Global search' })).toBeTruthy()
  })

  it('closes when Escape is pressed', async () => {
    render(GlobalSearch, { props: { open: true } })
    await fireEvent.keyDown(screen.getByRole('dialog', { name: 'Global search' }), {
      key: 'Escape',
    })
    expect(screen.queryByRole('dialog', { name: 'Global search' })).toBeNull()
  })

  it('closes when backdrop is clicked', async () => {
    render(GlobalSearch, { props: { open: true } })
    const backdrop = document.querySelector('[role="presentation"]') as HTMLElement
    await fireEvent.click(backdrop)
    expect(screen.queryByRole('dialog', { name: 'Global search' })).toBeNull()
  })

  it('renders credential results with project badge and snippet', async () => {
    installSearchFetchMock(() => searchResponse([credentialResult]))
    render(GlobalSearch, { props: { open: true } })
    const input = screen.getByLabelText('Search')
    await fireEvent.input(input, { target: { value: 'stripe' } })
    expect(await screen.findByText('Payments', {}, { timeout: 1000 })).toBeTruthy()
    expect(screen.getByText(/API Key for prod/i)).toBeTruthy()
  })

  it('renders project results with credential count', async () => {
    installSearchFetchMock(() => searchResponse([projectResult], 'infra'))
    render(GlobalSearch, { props: { open: true } })
    await fireEvent.input(screen.getByLabelText('Search'), { target: { value: 'infra' } })
    await vi.waitFor(() => expect(screen.getByText(/12 credentials/i)).toBeTruthy())
  })

  it('shows loading state during fetch', async () => {
    vi.useFakeTimers()
    let resolveFetch!: (value: Response) => void
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve
    })
    installSearchFetchMock(() => pending)
    render(GlobalSearch, { props: { open: true } })
    await fireEvent.input(screen.getByLabelText('Search'), { target: { value: 'stripe' } })
    await vi.advanceTimersByTimeAsync(200)
    expect(screen.getByText('Searching…')).toBeTruthy()
    resolveFetch(searchResponse([credentialResult]))
    await vi.waitFor(() => expect(screen.queryByText('Searching…')).toBeNull())
  })

  it('shows empty state when results are empty and query is non-empty', async () => {
    installSearchFetchMock(() => searchResponse([]))
    render(GlobalSearch, { props: { open: true } })
    await fireEvent.input(screen.getByLabelText('Search'), { target: { value: 'nomatch' } })
    await vi.waitFor(() => expect(screen.getByText(/No results for "nomatch"/i)).toBeTruthy())
  })

  it('does not fire API call when query is empty', async () => {
    const fetchMock = vi.fn(() => searchResponse([]))
    installSearchFetchMock(fetchMock)
    render(GlobalSearch, { props: { open: true } })
    await fireEvent.input(screen.getByLabelText('Search'), { target: { value: '   ' } })
    await new Promise((r) => setTimeout(r, 250))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('debounces input — only fires after 200ms of inactivity', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(() => searchResponse([credentialResult]))
    installSearchFetchMock(fetchMock)
    render(GlobalSearch, { props: { open: true } })
    const input = screen.getByLabelText('Search')
    await fireEvent.input(input, { target: { value: 's' } })
    await fireEvent.input(input, { target: { value: 'st' } })
    expect(fetchMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('cancels previous in-flight request when new query is typed (AbortController)', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = []
    installSearchFetchMock((_url, init) => {
      if (init?.signal) signals.push(init.signal)
      return new Promise<Response>((resolve) =>
        setTimeout(() => resolve(searchResponse([credentialResult])), 500)
      )
    })
    render(GlobalSearch, { props: { open: true } })
    const input = screen.getByLabelText('Search')
    await fireEvent.input(input, { target: { value: 'first' } })
    await vi.advanceTimersByTimeAsync(200)
    await fireEvent.input(input, { target: { value: 'second' } })
    await vi.advanceTimersByTimeAsync(200)
    expect(signals.length).toBeGreaterThanOrEqual(2)
    expect(signals[0]?.aborted).toBe(true)
  })

  it('navigates to credential page on credential result selection', async () => {
    installSearchFetchMock(() => searchResponse([credentialResult]))
    render(GlobalSearch, { props: { open: true } })
    await fireEvent.input(screen.getByLabelText('Search'), { target: { value: 'stripe' } })
    await vi.waitFor(() => screen.getByText('Payments'))
    await fireEvent.click(screen.getByRole('button', { name: /Payments/i }))
    expect(gotoMock).toHaveBeenCalledWith('/projects/proj-1/credentials/cred-1')
  })

  it('navigates to project page on project result selection', async () => {
    installSearchFetchMock(() => searchResponse([projectResult], 'infra'))
    render(GlobalSearch, { props: { open: true } })
    await fireEvent.input(screen.getByLabelText('Search'), { target: { value: 'infra' } })
    await vi.waitFor(() => screen.getByText(/12 credentials/i))
    await fireEvent.click(screen.getByRole('button', { name: /Infra Core/i }))
    expect(gotoMock).toHaveBeenCalledWith('/projects/proj-2')
  })

  it('highlights matching substring in result names', async () => {
    installSearchFetchMock(() => searchResponse([credentialResult]))
    render(GlobalSearch, { props: { open: true } })
    await fireEvent.input(screen.getByLabelText('Search'), { target: { value: 'stripe' } })
    await vi.waitFor(() => expect(document.querySelector('mark')).toBeTruthy())
  })

  it('shows expiry badge for credentials expiring within 30 days', async () => {
    installSearchFetchMock(() => searchResponse([credentialResult]))
    render(GlobalSearch, { props: { open: true } })
    await fireEvent.input(screen.getByLabelText('Search'), { target: { value: 'stripe' } })
    await vi.waitFor(() => expect(screen.getByText(/expires in/i)).toBeTruthy())
  })
})
