export type SsePayloadMap = {
  'secret.updated': { secretId: string; orgId: string }
  'rotation.completed': { rotationId: string; orgId: string }
}

export type SseEventType = keyof SsePayloadMap
export type SsePayload<T extends SseEventType> = SsePayloadMap[T]
