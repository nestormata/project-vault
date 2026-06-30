import { EventEmitter } from 'node:events'
import type { SseEventType, SsePayloadMap } from '@project-vault/shared'

export type AppEventEmitter = EventEmitter

export type SseEnvelope<T extends SseEventType = SseEventType> = {
  event: T
  projectId: string
  orgId: string
  data: SsePayloadMap[T]
  timestamp: string
}

export function createEventEmitter(): AppEventEmitter {
  return new EventEmitter()
}

export function emitSseEvent<T extends SseEventType>(
  emitter: AppEventEmitter,
  event: T,
  projectId: string,
  orgId: string,
  data: SsePayloadMap[T]
): void {
  const envelope: SseEnvelope<T> = {
    event,
    projectId,
    orgId,
    data,
    timestamp: new Date().toISOString(),
  }
  emitter.emit('sse', envelope)
}
