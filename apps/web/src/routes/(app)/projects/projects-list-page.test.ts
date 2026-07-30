import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'

vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
  invalidateAll: vi.fn(),
}))

vi.mock('$app/state', () => ({
  page: { url: new URL('http://localhost/projects') },
}))

import { goto } from '$app/navigation'
import ProjectsListPage from './+page.svelte'

afterEach(() => cleanup())

const project = {
  id: 'p1',
  name: 'Payments API',
  slug: 'payments-api',
  description: 'Stripe + billing webhooks',
  role: 'owner' as const,
  credentialCount: 3,
  expiringCount: 1,
  alertCount: 0,
  tags: [] as string[],
  createdAt: '2026-01-01T00:00:00.000Z',
  archivedAt: null,
  isArchived: false,
}

describe('projects list +page.svelte (AC-12)', () => {
  it('the project name links to the overview page, and "View credentials" stays a separate secondary link', () => {
    render(ProjectsListPage, {
      props: { data: { projects: { items: [project] }, includeArchived: false } },
    })

    const nameLink = screen.getByRole('link', { name: 'Payments API' })
    expect(nameLink.getAttribute('href')).toBe('/projects/p1')

    const credentialsLink = screen.getByRole('link', { name: 'View credentials' })
    expect(credentialsLink.getAttribute('href')).toBe('/projects/p1/credentials')
  })
})

// Story 18.4 AC-1/AC-4/AC-5: the "Show archived"/"Hide archived" toggle button was the one
// confirmed root-cause class found by this story's audit (AC-3) of every toggle-style button in
// the app — unlike every sibling action on this same page (onArchive/onUnarchive/onSaveTags), it
// had no re-entrancy guard at all, and computed its next URL param by re-reading the `data`
// prop — which SvelteKit only swaps in once `goto(..., { invalidateAll: true })` actually
// resolves. A second click fired before that resolution reads the same stale `data.includeArchived`
// value instead of the button's own just-clicked intent, so rapid clicks don't accumulate as
// alternating toggles the way a properly-guarded control would. Reproduced deterministically (per
// AC-4) by holding `goto()`'s promise unresolved and firing two synchronous clicks before it
// settles — never a wall-clock setTimeout race.
describe('projects list +page.svelte — "Show archived" toggle double-click race (Story 18.4)', () => {
  afterEach(() => {
    vi.mocked(goto).mockReset()
  })

  it('AC-1/AC-4 reproduction: a second click fired before goto() resolves is ignored, not re-sent', async () => {
    let resolveGoto: () => void = () => {}
    const pendingGoto = new Promise<void>((resolve) => {
      resolveGoto = resolve
    })
    vi.mocked(goto).mockReturnValue(pendingGoto)

    render(ProjectsListPage, {
      props: { data: { projects: { items: [] }, includeArchived: false } },
    })

    const button = screen.getByRole('button', { name: 'Show archived' })
    await fireEvent.click(button)
    // Second click, fired synchronously before the first goto() call's promise has flushed —
    // the deterministic race repro (AC-4), not a setTimeout-based approximation.
    await fireEvent.click(button)

    // AC-5: a real rapid double-click on the toggle must not re-trigger the navigation a second
    // time while the first is still in flight.
    expect(goto).toHaveBeenCalledTimes(1)

    resolveGoto()
    await pendingGoto
  })

  it('AC-5: once the in-flight navigation resolves, the button is re-enabled and clickable again', async () => {
    let resolveGoto: () => void = () => {}
    const pendingGoto = new Promise<void>((resolve) => {
      resolveGoto = resolve
    })
    vi.mocked(goto).mockReturnValueOnce(pendingGoto).mockReturnValue(Promise.resolve())

    render(ProjectsListPage, {
      props: { data: { projects: { items: [] }, includeArchived: false } },
    })

    const button = screen.getByRole('button', { name: 'Show archived' })
    await fireEvent.click(button)
    resolveGoto()
    await pendingGoto
    // Let the component's own `await goto(...)` continuation (which flips `togglingArchived`
    // back to false in its `finally`) run past this microtask before clicking again.
    await Promise.resolve()

    await fireEvent.click(button)
    expect(goto).toHaveBeenCalledTimes(2)
  })

  it('AC-6: exposes aria-pressed reflecting the current archived-filter state', () => {
    const { rerender } = render(ProjectsListPage, {
      props: { data: { projects: { items: [] }, includeArchived: false } },
    })

    expect(screen.getByRole('button', { name: 'Show archived' }).getAttribute('aria-pressed')).toBe(
      'false'
    )

    rerender({ data: { projects: { items: [] }, includeArchived: true } })
    expect(screen.getByRole('button', { name: 'Hide archived' }).getAttribute('aria-pressed')).toBe(
      'true'
    )
  })

  it('AC-7: a single click still toggles to the correct target (no change to existing semantics)', async () => {
    vi.mocked(goto).mockResolvedValue(undefined)

    render(ProjectsListPage, {
      props: { data: { projects: { items: [] }, includeArchived: false } },
    })

    await fireEvent.click(screen.getByRole('button', { name: 'Show archived' }))
    expect(goto).toHaveBeenCalledWith('?includeArchived=true', { invalidateAll: true })
  })
})
