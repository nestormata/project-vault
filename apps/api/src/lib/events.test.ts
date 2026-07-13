import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createEventEmitter, emitSseEvent, type SseEnvelope } from './events.js'

const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

describe('createEventEmitter', () => {
  it('returns an actual EventEmitter instance', () => {
    const emitter = createEventEmitter()

    expect(emitter).toBeInstanceOf(EventEmitter)
  })
})

describe('emitSseEvent', () => {
  it('emits an sse event with the correct envelope for a secret.updated payload', () => {
    const emitter = createEventEmitter()
    const listener = vi.fn()
    emitter.on('sse', listener)

    emitSseEvent(emitter, 'secret.updated', 'project-1', 'org-1', {
      secretId: 'secret-1',
      orgId: 'org-1',
    })

    expect(listener).toHaveBeenCalledTimes(1)
    const envelope = listener.mock.calls[0]?.[0] as SseEnvelope<'secret.updated'>
    expect(envelope.event).toBe('secret.updated')
    expect(envelope.projectId).toBe('project-1')
    expect(envelope.orgId).toBe('org-1')
    expect(envelope.data).toEqual({ secretId: 'secret-1', orgId: 'org-1' })
    expect(envelope.timestamp).toMatch(ISO_8601_REGEX)
    expect(new Date(envelope.timestamp).toString()).not.toBe('Invalid Date')
  })

  it('emits an sse event with the correct envelope for a notification.inbox payload', () => {
    const emitter = createEventEmitter()
    const listener = vi.fn()
    emitter.on('sse', listener)

    emitSseEvent(emitter, 'notification.inbox', 'project-2', 'org-2', {
      unreadCount: 5,
    })

    expect(listener).toHaveBeenCalledTimes(1)
    const envelope = listener.mock.calls[0]?.[0] as SseEnvelope<'notification.inbox'>
    expect(envelope.event).toBe('notification.inbox')
    expect(envelope.projectId).toBe('project-2')
    expect(envelope.orgId).toBe('org-2')
    expect(envelope.data).toEqual({ unreadCount: 5 })
    expect(envelope.timestamp).toMatch(ISO_8601_REGEX)
    expect(new Date(envelope.timestamp).toString()).not.toBe('Invalid Date')
  })

  it('does not invoke listeners subscribed to a different event name', () => {
    const emitter = createEventEmitter()
    const otherListener = vi.fn()
    emitter.on('not-sse', otherListener)

    emitSseEvent(emitter, 'rotation.completed', 'project-3', 'org-3', {
      rotationId: 'rotation-1',
      orgId: 'org-3',
    })

    expect(otherListener).not.toHaveBeenCalled()
  })
})
