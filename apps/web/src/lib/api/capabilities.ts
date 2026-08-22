import { apiFetch } from './client.js'

// Story 23.7 — mirrors extensions.ts's/status-page.ts's apiFetch<T>() convention exactly. No
// client-side caching, no polling, no browser storage: fetched fresh on every SSR load (AC-7/Task 4).
export type CapabilityMap = Record<string, boolean>

export function getCapabilityMap(fetchFn: typeof fetch) {
  return apiFetch<{ capabilities: CapabilityMap }>(fetchFn, '/api/v1/capabilities')
}
