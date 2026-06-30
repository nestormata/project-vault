import { connectSse, onSseEvent } from './sse.svelte.js'
import type { NotificationInboxPayload } from '@project-vault/shared'

let unreadCount = $state(0)
let initialized = $state(false)
let disconnectSse: (() => void) | null = null

export function getUnreadCount(): number {
  return unreadCount
}

export function isInitialized(): boolean {
  return initialized
}

export function setInitialUnreadCount(count: number): void {
  unreadCount = count
  initialized = true
}

export function subscribeToInboxEvents(): () => void {
  disconnectSse ??= connectSse()
  const unsubscribe = onSseEvent('notification.inbox', (event: NotificationInboxPayload) => {
    unreadCount = event.unreadCount
  })
  return () => {
    unsubscribe()
    disconnectSse?.()
    disconnectSse = null
  }
}

export function markAllReadLocally(): void {
  unreadCount = 0
}

export function decrementUnread(by = 1): void {
  unreadCount = Math.max(0, unreadCount - by)
}
