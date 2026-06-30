export interface NotificationInboxPayload {
  unreadCount: number
}

export type SsePayloadMap = {
  'secret.updated': { secretId: string; orgId: string }
  'rotation.completed': { rotationId: string; orgId: string }
  'notification.inbox': NotificationInboxPayload
}

export type SseEventType = keyof SsePayloadMap
export type SsePayload<T extends SseEventType> = SsePayloadMap[T]
