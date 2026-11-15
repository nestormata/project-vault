// Story 73.15: opening the command palette under the rail shell must not throw
// Svelte `state_unsafe_mutation`. Header-only palette tests never mount the bottom bar.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { tick } from 'svelte'

vi.mock('$app/navigation', () => ({ goto: vi.fn(async () => {}) }))
vi.mock('$lib/api/auth.js', () => ({ logout: vi.fn(async () => undefined) }))
const mockedPage = vi.hoisted(() => ({
  url: new URL('http://localhost/dashboard'),
  data: { user: { orgRole: 'owner', userId: 'u1' } } as { user?: Record<string, unknown> },
}))
vi.mock('$app/state', () => ({ page: mockedPage }))

import { testAuthUser } from '$lib/test/page-data.js'
import RailPaletteHarness from './RailPaletteHarness.test.svelte'

function collectPageErrors() {
  const hits: string[] = []
  const onError = (event: ErrorEvent) => {
    hits.push(String(event.error ?? event.message))
  }
  const onReject = (event: PromiseRejectionEvent) => {
    hits.push(String(event.reason))
  }
  const errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    hits.push(args.map(String).join(' '))
  })
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onReject)
  return {
    hits,
    restore() {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onReject)
      errorSpy.mockRestore()
    },
  }
}

function mutationHits(hits: string[]) {
  return hits.filter((hit) => /state_unsafe_mutation|unhandled/i.test(hit))
}

afterEach(() => {
  cleanup()
  mockedPage.url = new URL('http://localhost/dashboard')
  mockedPage.data = { user: { orgRole: 'owner', userId: 'u1' } }
})

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ error: 'not_found' }), { status: 404 }))
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AppShell variant="rail" + command palette (Story 73.15)', () => {
  it('opening the palette does not throw state_unsafe_mutation', async () => {
    const errors = collectPageErrors()
    render(RailPaletteHarness, { props: { user: testAuthUser({ orgRole: 'admin' }), open: false } })
    expect(screen.getByTestId('nav-rail')).toBeTruthy()
    expect(screen.getByTestId('bottom-bar')).toBeTruthy()

    await fireEvent.click(screen.getByTestId('header-search-field'))
    await tick()
    expect(await screen.findByRole('dialog', { name: 'Global search' })).toBeTruthy()
    errors.restore()
    expect(mutationHits(errors.hits)).toEqual([])
  })

  it('mounting with the palette already open does not throw state_unsafe_mutation', async () => {
    const errors = collectPageErrors()
    render(RailPaletteHarness, { props: { user: testAuthUser({ orgRole: 'admin' }), open: true } })
    expect(await screen.findByRole('dialog', { name: 'Global search' })).toBeTruthy()
    await tick()
    errors.restore()
    expect(mutationHits(errors.hits)).toEqual([])
  })

  it('open, type, and dismiss still work under the rail shell', async () => {
    const errors = collectPageErrors()
    render(RailPaletteHarness, { props: { user: testAuthUser({ orgRole: 'owner' }), open: false } })
    await fireEvent.click(screen.getByTestId('header-search-icon'))
    const dialog = await screen.findByRole('dialog', { name: 'Global search' })
    const input = screen.getByRole('combobox', { name: 'Search' })
    await fireEvent.input(input, { target: { value: 'zz-nothing' } })
    await tick()
    await fireEvent.keyDown(dialog, { key: 'Escape' })
    await tick()
    expect(screen.queryByRole('dialog', { name: 'Global search' })).toBeNull()
    errors.restore()
    expect(mutationHits(errors.hits)).toEqual([])
  })
})
