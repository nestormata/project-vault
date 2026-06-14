import { EventEmitter } from 'node:events'
import type { SseEventType, SsePayloadMap } from '@project-vault/shared'

export type AppEventEmitter = EventEmitter

export function createEventEmitter(): AppEventEmitter {
  // Story 1.11 expands with typed event emitter
  return new EventEmitter()
}

export function emitSseEvent<T extends SseEventType>(
  _emitter: AppEventEmitter,
  _event: T,
  _payload: SsePayloadMap[T]
): void {
  // Story 1.11 implements SSE ring buffer and delivery
}
