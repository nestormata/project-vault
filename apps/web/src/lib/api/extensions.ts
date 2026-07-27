import { apiFetch } from './client.js'

// Story 14.5 Task 2: mirrors apps/api/src/extensions/status-routes.ts's
// `ExtensionStatusResponseSchema` (a union of the manifest object or `z.null()`, sent as the
// bare response body — no `data` envelope wrapper).
export type ExtensionCapability = 'auth-provider' | 'notification-channel' | 'ui-panel'

export type ExtensionStatus = {
  name: string
  apiVersion: string
  capabilities: ExtensionCapability[]
  loadedAt: string
}

export function getExtensionStatus(fetchFn: typeof fetch) {
  return apiFetch<ExtensionStatus | null>(fetchFn, '/api/v1/admin/extensions/status')
}
