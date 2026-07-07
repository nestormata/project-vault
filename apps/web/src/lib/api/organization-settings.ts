import { apiFetch } from './client.js'

export type DormancyThresholdDays = 30 | 60 | 90 | 180

export type MachineKeySettingsResponse = {
  orgId: string
  machineKeyDormancyThresholdDays: number
}

// AC-4 — there is no GET endpoint for this setting (only `PATCH`, shipped by 7.2/8.3 for the
// dormancy jobs' own threshold column); this story is explicitly scoped to add no new backend
// endpoint for AC-1–AC-4 (see Dev Notes), so the web UI can set a new threshold but cannot display
// the org's current one. See the `/settings/users` dormancy-threshold control for how this is
// disclosed in the UI copy itself, rather than silently faking a "current value."
export function updateMachineKeyDormancyThreshold(
  fetchFn: typeof fetch,
  orgId: string,
  machineKeyDormancyThresholdDays: DormancyThresholdDays
) {
  return apiFetch<MachineKeySettingsResponse>(
    fetchFn,
    `/api/v1/organizations/${orgId}/machine-key-settings`,
    { method: 'PATCH', body: JSON.stringify({ machineKeyDormancyThresholdDays }) }
  )
}
