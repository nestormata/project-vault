// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import * as notifications from './notifications.svelte.js'
import {
  decrementUnread,
  getUnreadCount,
  isInitialized,
  markAllReadLocally,
  setInitialUnreadCount,
} from './notifications.svelte.js'

describe('notifications.svelte.ts', () => {
  beforeEach(() => {
    setInitialUnreadCount(0)
  })

  it('setInitialUnreadCount sets the count and marks initialized', () => {
    setInitialUnreadCount(7)

    expect(getUnreadCount()).toBe(7)
    expect(isInitialized()).toBe(true)
  })

  it('markAllReadLocally resets the count to zero', () => {
    setInitialUnreadCount(5)
    markAllReadLocally()

    expect(getUnreadCount()).toBe(0)
  })

  it('decrementUnread with a default of 1 reduces the count', () => {
    setInitialUnreadCount(3)
    decrementUnread()

    expect(getUnreadCount()).toBe(2)
  })

  it('decrementUnread never goes below zero (clamped branch)', () => {
    setInitialUnreadCount(1)
    decrementUnread(5)

    expect(getUnreadCount()).toBe(0)
  })

  // Story 63.2 AC-1: the api has no /api/v1/stream route, so the inbox never opens an EventSource.
  it('does not expose an SSE subscription and never opens an EventSource', () => {
    const eventSource = vi.fn()
    vi.stubGlobal('EventSource', eventSource)

    expect('subscribeToInboxEvents' in notifications).toBe(false)
    setInitialUnreadCount(3)
    decrementUnread()

    expect(getUnreadCount()).toBe(2)
    expect(eventSource).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
