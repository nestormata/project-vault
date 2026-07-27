import type { SupportedLocale } from '@project-vault/shared'
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

export type UserDormancySettingsResponse = {
  orgId: string
  userDormancyThresholdDays: number
}

// Story 8.7 AC-I1 — sibling setting for `user.dormant` alerts (Story 8.3), same D2 "no GET
// readback, set-a-new-value-only" shape as the machine-key threshold above. Note the distinct
// route prefix: `/api/v1/organizations` (plural), not `/api/v1/org` (see the story's endpoint
// inventory table).
export function updateUserDormancyThreshold(
  fetchFn: typeof fetch,
  orgId: string,
  userDormancyThresholdDays: DormancyThresholdDays
) {
  return apiFetch<UserDormancySettingsResponse>(
    fetchFn,
    `/api/v1/organizations/${orgId}/user-dormancy-settings`,
    { method: 'PATCH', body: JSON.stringify({ userDormancyThresholdDays }) }
  )
}

export type OrgDefaultLocaleSettingsResponse = {
  orgId: string
  defaultLocale: string
}

// Story 15.2 AC 1 — third setting in this file, same "no GET readback, set-a-new-value-only"
// shape as the two dormancy thresholds above (see this story's Dev Notes ADR "no GET readback
// for the org default" — deliberate, not an oversight): the web UI can set a new org default
// display-language for future invitees but cannot display the org's current one.
export function updateOrgDefaultLocale(
  fetchFn: typeof fetch,
  orgId: string,
  defaultLocale: SupportedLocale
) {
  return apiFetch<OrgDefaultLocaleSettingsResponse>(
    fetchFn,
    `/api/v1/organizations/${orgId}/default-locale-settings`,
    { method: 'PATCH', body: JSON.stringify({ defaultLocale }) }
  )
}
