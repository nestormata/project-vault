import { apiFetch } from './client.js'

// Story 14.5 Task 2 / Story 23.2 AC-12: mirrors apps/api/src/extensions/status-routes.ts's
// response envelope — `{ extension, nativeLoginPolicy }`. Story 23.2 AC-12 deliberately broke
// the original bare manifest-or-null response shape into this envelope in the same commit as
// the API route change and the regenerated openapi.json.
export type ExtensionCapability = 'auth-provider' | 'notification-channel' | 'ui-panel'

export type ExtensionStatus = {
  name: string
  apiVersion: string
  capabilities: ExtensionCapability[]
  loadedAt: string
}

export type NativeLoginPolicyState =
  'enabled' | 'replacement_declared_unproven' | 'disabled' | 'break_glass'

export type NativeLoginPolicy = {
  enabled: boolean
  state: NativeLoginPolicyState
  replacementDeclared: boolean
  replacementProven: boolean
  replacementProvenAt: string | null
  appliedAtBoot: boolean
  breakGlassActive: boolean
  replacementConfirmedOverride: boolean
  extensionStatus: 'not_configured' | 'loaded' | 'load_failed'
  extensionFailureReason: string | null
  sessionsLive: number
}

export type ExtensionStatusEnvelope = {
  extension: ExtensionStatus | null
  nativeLoginPolicy: NativeLoginPolicy
}

export function getExtensionStatus(fetchFn: typeof fetch) {
  return apiFetch<ExtensionStatusEnvelope>(fetchFn, '/api/v1/admin/extensions/status')
}
