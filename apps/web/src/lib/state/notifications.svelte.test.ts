// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const connectSseMock = vi.hoisted(() => vi.fn())
const onSseEventMock = vi.hoisted(() => vi.fn())

vi.mock('./sse.svelte.js', () => ({
  connectSse: connectSseMock,
  onSseEvent: onSseEventMock,
}))

import {
  decrementUnread,
  getUnreadCount,
  isInitialized,
  markAllReadLocally,
  setInitialUnreadCount,
  subscribeToInboxEvents,
} from './notifications.svelte.js'

describe('notifications.svelte.ts', () => {
  beforeEach(() => {
    connectSseMock.mockReset()
    onSseEventMock.mockReset()
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

  it('subscribeToInboxEvents connects SSE once and updates the count on inbox events', () => {
    let inboxHandler: ((event: { unreadCount: number }) => void) | undefined
    const unsubscribe = vi.fn()
    onSseEventMock.mockImplementation((_event: string, handler: typeof inboxHandler) => {
      inboxHandler = handler
      return unsubscribe
    })
    const disconnectSse = vi.fn()
    connectSseMock.mockReturnValue(disconnectSse)

    const cleanup = subscribeToInboxEvents()
    inboxHandler?.({ unreadCount: 42 })

    expect(getUnreadCount()).toBe(42)
    expect(connectSseMock).toHaveBeenCalledTimes(1)

    cleanup()
    expect(unsubscribe).toHaveBeenCalled()
    expect(disconnectSse).toHaveBeenCalled()
  })

  it('subscribeToInboxEvents reuses the existing SSE connection on a second subscribe (??= branch)', () => {
    const disconnectSse = vi.fn()
    connectSseMock.mockReturnValue(disconnectSse)
    onSseEventMock.mockReturnValue(vi.fn())

    const cleanupFirst = subscribeToInboxEvents()
    const cleanupSecond = subscribeToInboxEvents()

    expect(connectSseMock).toHaveBeenCalledTimes(1)

    cleanupSecond()
    cleanupFirst()
  })
})
