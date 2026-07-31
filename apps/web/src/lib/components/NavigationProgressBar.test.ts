import { cleanup, render, screen } from '@testing-library/svelte'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { tick, type Component } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const navigatingStore = vi.hoisted(() => {
  let value: unknown = null
  const subscribers = new Set<(value: unknown) => void>()

  return {
    subscribe(run: (value: unknown) => void) {
      run(value)
      subscribers.add(run)
      return () => subscribers.delete(run)
    },
    set(next: unknown) {
      value = next
      subscribers.forEach((run) => run(value))
    },
  }
})

vi.mock('$app/stores', () => ({
  navigating: navigatingStore,
}))

import NavigationProgressBar from './NavigationProgressBar.svelte'

const pendingNavigation = { from: null, to: { params: {}, route: {} } }

async function setNavigation(value: unknown) {
  navigatingStore.set(value)
  await tick()
}

describe('NavigationProgressBar', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    navigatingStore.set(null)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('does not flash for a navigation that resolves before the 180ms reveal delay', async () => {
    render(NavigationProgressBar as Component)

    await setNavigation(pendingNavigation)
    vi.advanceTimersByTime(179)
    await tick()
    expect(screen.queryByRole('status')).toBeNull()

    await setNavigation(null)
    vi.advanceTimersByTime(1)
    await tick()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('shows after the delayed reveal threshold and hides when navigation resolves', async () => {
    render(NavigationProgressBar as Component)

    await setNavigation(pendingNavigation)
    vi.advanceTimersByTime(180)
    await tick()

    expect(screen.getByRole('status', { name: /loading page/i })).toBeTruthy()

    await setNavigation(null)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('cancels a pending delayed reveal when navigation is cancelled', async () => {
    render(NavigationProgressBar as Component)

    await setNavigation(pendingNavigation)
    await setNavigation(null)
    vi.advanceTimersByTime(180)
    await tick()

    expect(screen.queryByRole('status')).toBeNull()
  })

  it('restarts the reveal delay when a cancelled navigation is immediately replaced', async () => {
    render(NavigationProgressBar as Component)

    await setNavigation(pendingNavigation)
    vi.advanceTimersByTime(100)
    navigatingStore.set(null)
    navigatingStore.set({ from: { route: {} }, to: { params: {}, route: {} } })
    await tick()

    vi.advanceTimersByTime(79)
    await tick()
    expect(screen.queryByRole('status')).toBeNull()

    vi.advanceTimersByTime(1)
    await tick()
    expect(screen.queryByRole('status')).toBeNull()

    vi.advanceTimersByTime(100)
    await tick()
    expect(screen.getByRole('status', { name: /loading page/i })).toBeTruthy()
  })

  it('clears a visible indicator when the navigation store reports cancellation or an errored route', async () => {
    render(NavigationProgressBar as Component)

    await setNavigation(pendingNavigation)
    vi.advanceTimersByTime(180)
    await tick()
    expect(screen.getByRole('status')).toBeTruthy()

    await setNavigation(null)
    expect(screen.queryByRole('status')).toBeNull()

    await setNavigation({ from: { route: {} }, to: null })
    vi.advanceTimersByTime(180)
    await tick()
    expect(screen.getByRole('status')).toBeTruthy()

    await setNavigation(null)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('exposes a polite status and declares a reduced-motion-safe animation treatment', async () => {
    render(NavigationProgressBar as Component)
    await setNavigation(pendingNavigation)
    vi.advanceTimersByTime(180)
    await tick()

    const status = screen.getByRole('status', { name: /loading page/i })
    expect(status.getAttribute('aria-live')).toBe('polite')

    const progressBar = status.querySelector('[data-navigation-progress-bar]')
    expect(progressBar?.className).toContain('navigation-progress-bar')
    const componentSource = readFileSync(
      resolve(process.cwd(), 'src/lib/components/NavigationProgressBar.svelte'),
      'utf8'
    )
    expect(componentSource).toContain('@media (prefers-reduced-motion: reduce)')
    expect(componentSource).toContain('animation: none')
  })
})
