import { describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '$lib/test/json-response.js'
import {
  updateMachineKeyDormancyThreshold,
  updateOrgDefaultLocale,
  updateUserDormancyThreshold,
} from './organization-settings.js'

describe('updateMachineKeyDormancyThreshold (AC-4)', () => {
  it('PATCHes the org-scoped machine-key-settings endpoint', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ data: { orgId: 'org-1', machineKeyDormancyThresholdDays: 90 } })
      )
    const result = await updateMachineKeyDormancyThreshold(fetchFn, 'org-1', 90)
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/organizations/org-1/machine-key-settings',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ machineKeyDormancyThresholdDays: 90 }),
      })
    )
    expect(result.machineKeyDormancyThresholdDays).toBe(90)
  })
})

// Story 8.7 AC-I1 — sibling setting for `user.dormant` alerts (distinct from the machine-key
// threshold above), same "no GET readback" (D2) shape.
describe('updateUserDormancyThreshold (AC-I1)', () => {
  it('PATCHes the org-scoped user-dormancy-settings endpoint (note: plural "organizations")', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: { orgId: 'org-1', userDormancyThresholdDays: 60 } }))
    const result = await updateUserDormancyThreshold(fetchFn, 'org-1', 60)
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/organizations/org-1/user-dormancy-settings',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ userDormancyThresholdDays: 60 }),
      })
    )
    expect(result.userDormancyThresholdDays).toBe(60)
  })
})

// Story 15.2 AC 1 — third setting on this same page, same "no GET readback" (set-only) shape as
// the two dormancy thresholds above.
describe('updateOrgDefaultLocale (Story 15.2 AC 1)', () => {
  it('PATCHes the org-scoped default-locale-settings endpoint', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: { orgId: 'org-1', defaultLocale: 'es' } }))
    const result = await updateOrgDefaultLocale(fetchFn, 'org-1', 'es')
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/organizations/org-1/default-locale-settings',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ defaultLocale: 'es' }),
      })
    )
    expect(result.defaultLocale).toBe('es')
  })
})
