import { describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '$lib/test/json-response.js'
import { updateMachineKeyDormancyThreshold } from './organization-settings.js'

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
