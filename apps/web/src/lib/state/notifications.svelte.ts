let unreadCount = $state(0)
let initialized = $state(false)

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

export function markAllReadLocally(): void {
  unreadCount = 0
}

export function decrementUnread(by = 1): void {
  unreadCount = Math.max(0, unreadCount - by)
}
