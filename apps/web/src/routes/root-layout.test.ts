import { cleanup, render, screen } from '@testing-library/svelte'
import { createRawSnippet, tick } from 'svelte'
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

import RootLayout from './+layout.svelte'

function childrenSnippet() {
  return createRawSnippet(() => ({
    render: () => '<p>page content</p>',
  }))
}

describe('root layout navigation feedback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    navigatingStore.set(null)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('mounts one global navigation indicator around the page content', async () => {
    render(RootLayout, { props: { children: childrenSnippet() } })

    navigatingStore.set({ from: null, to: { params: {}, route: {} } })
    await tick()
    vi.advanceTimersByTime(180)
    await tick()

    expect(screen.getByText('page content')).toBeTruthy()
    expect(screen.getByRole('status', { name: /loading page/i })).toBeTruthy()
  })
})
