import type { SseEventType, SsePayloadMap } from '@project-vault/shared'

type SseListener<T extends SseEventType> = (data: SsePayloadMap[T]) => void

type ListenerEntry = {
  event: SseEventType
  listener: SseListener<SseEventType>
}

const listeners: ListenerEntry[] = []
let eventSource: EventSource | null = null

function dispatchEvent<T extends SseEventType>(event: T, data: SsePayloadMap[T]) {
  for (const entry of listeners) {
    if (entry.event === event) {
      entry.listener(data as SsePayloadMap[SseEventType])
    }
  }
}

function handleSseMessage(message: MessageEvent<string>) {
  try {
    const envelope = JSON.parse(message.data) as {
      event: SseEventType
      projectId?: string
      orgId?: string
      data: SsePayloadMap[SseEventType]
    }
    if (!envelope?.event || envelope.data === undefined) return
    dispatchEvent(envelope.event, envelope.data)
  } catch {
    // Ignore malformed SSE payloads.
  }
}

export function connectSse(): () => void {
  if (typeof EventSource === 'undefined') return () => {}
  if (eventSource) return () => {}

  eventSource = new EventSource('/api/v1/stream', { withCredentials: true })
  eventSource.onmessage = handleSseMessage
  eventSource.addEventListener('notification.inbox', handleSseMessage as EventListener)

  return () => {
    eventSource?.close()
    eventSource = null
  }
}

export function onSseEvent<T extends SseEventType>(event: T, listener: SseListener<T>): () => void {
  const entry: ListenerEntry = {
    event,
    listener: listener as SseListener<SseEventType>,
  }
  listeners.push(entry)
  return () => {
    const index = listeners.indexOf(entry)
    if (index >= 0) listeners.splice(index, 1)
  }
}

export function emitSseEventForTesting<T extends SseEventType>(
  event: T,
  data: SsePayloadMap[T]
): void {
  dispatchEvent(event, data)
}
