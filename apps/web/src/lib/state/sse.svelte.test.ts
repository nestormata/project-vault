// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectSse, emitSseEventForTesting, onSseEvent } from './sse.svelte.js'

class FakeEventSource {
  static instances: FakeEventSource[] = []
  url: string
  opts: unknown
  onmessage: ((event: MessageEvent<string>) => void) | null = null
  listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>()
  closed = false

  constructor(url: string, opts?: unknown) {
    this.url = url
    this.opts = opts
    FakeEventSource.instances.push(this)
  }

  addEventListener(event: string, listener: (event: MessageEvent<string>) => void) {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
  }

  close() {
    this.closed = true
  }

  emit(event: string, data: string) {
    const message = { data } as MessageEvent<string>
    if (event === 'message') {
      this.onmessage?.(message)
    } else {
      for (const listener of this.listeners.get(event) ?? []) listener(message)
    }
  }
}

let originalEventSource: typeof EventSource | undefined

beforeEach(() => {
  originalEventSource = globalThis.EventSource
  FakeEventSource.instances = []
  ;(globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource
})

afterEach(() => {
  if (originalEventSource) {
    globalThis.EventSource = originalEventSource
  } else {
    delete (globalThis as { EventSource?: unknown }).EventSource
  }
})

describe('sse.svelte.ts', () => {
  it('returns a no-op cleanup and does not connect when EventSource is unavailable', () => {
    delete (globalThis as { EventSource?: unknown }).EventSource

    const disconnect = connectSse()
    expect(FakeEventSource.instances.length).toBe(0)
    expect(() => disconnect()).not.toThrow()
  })

  it('connects a new EventSource to the stream endpoint with credentials', () => {
    const disconnect = connectSse()

    expect(FakeEventSource.instances.length).toBe(1)
    expect(FakeEventSource.instances[0].url).toBe('/api/v1/stream')
    expect(FakeEventSource.instances[0].opts).toEqual({ withCredentials: true })

    disconnect()
  })

  it('returns a no-op on a second connectSse call while already connected, and does not create a second instance', () => {
    const disconnectFirst = connectSse()
    const disconnectSecond = connectSse()

    expect(FakeEventSource.instances.length).toBe(1)
    expect(() => disconnectSecond()).not.toThrow()
    // the first instance is still open (second connect didn't close it)
    expect(FakeEventSource.instances[0].closed).toBe(false)

    disconnectFirst()
    expect(FakeEventSource.instances[0].closed).toBe(true)
  })

  it('dispatches a well-formed notification.inbox event only to matching listeners', () => {
    const disconnect = connectSse()
    const instance = FakeEventSource.instances[0]
    const inboxListener = vi.fn()
    const secretListener = vi.fn()
    const unsubInbox = onSseEvent('notification.inbox', inboxListener)
    const unsubSecret = onSseEvent('secret.updated', secretListener)

    instance.emit(
      'notification.inbox',
      JSON.stringify({ event: 'notification.inbox', data: { unreadCount: 3 } })
    )

    expect(inboxListener).toHaveBeenCalledWith({ unreadCount: 3 })
    expect(secretListener).not.toHaveBeenCalled()

    unsubInbox()
    unsubSecret()
    disconnect()
  })

  it('silently ignores a message with invalid JSON', () => {
    const disconnect = connectSse()
    const instance = FakeEventSource.instances[0]
    const listener = vi.fn()
    const unsub = onSseEvent('notification.inbox', listener)

    expect(() => instance.emit('message', 'not-json{')).not.toThrow()
    expect(listener).not.toHaveBeenCalled()

    unsub()
    disconnect()
  })

  it('ignores an envelope missing an event field', () => {
    const disconnect = connectSse()
    const instance = FakeEventSource.instances[0]
    const listener = vi.fn()
    const unsub = onSseEvent('notification.inbox', listener)

    instance.emit('message', JSON.stringify({ data: { unreadCount: 1 } }))

    expect(listener).not.toHaveBeenCalled()

    unsub()
    disconnect()
  })

  it('ignores an envelope whose data is undefined', () => {
    const disconnect = connectSse()
    const instance = FakeEventSource.instances[0]
    const listener = vi.fn()
    const unsub = onSseEvent('notification.inbox', listener)

    instance.emit('message', JSON.stringify({ event: 'notification.inbox' }))

    expect(listener).not.toHaveBeenCalled()

    unsub()
    disconnect()
  })

  it('unsubscribing twice is a safe no-op the second time', () => {
    const disconnect = connectSse()
    const listener = vi.fn()
    const unsub = onSseEvent('notification.inbox', listener)

    unsub()
    expect(() => unsub()).not.toThrow()

    disconnect()
  })

  it('emitSseEventForTesting directly dispatches to registered listeners', () => {
    const listener = vi.fn()
    const unsub = onSseEvent('rotation.completed', listener)

    emitSseEventForTesting('rotation.completed', { rotationId: 'r1', orgId: 'o1' })

    expect(listener).toHaveBeenCalledWith({ rotationId: 'r1', orgId: 'o1' })

    unsub()
  })
})
