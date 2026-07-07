import { describe, expect, it } from 'vitest'
import { toDormancyAlertViews, type SecurityAlertItem } from './dormancy-alerts.js'

function alert(overrides: Partial<SecurityAlertItem> = {}): SecurityAlertItem {
  return {
    id: 'alert-1',
    alertType: 'machine_key.dormant',
    status: 'delivered',
    createdAt: '2026-07-01T00:00:00.000Z',
    payload: {
      keyId: 'key-1',
      machineUserId: 'mu-1',
      machineUserName: 'ci-deploy-bot',
      keyName: 'prod-key',
      lastUsedAt: '2026-05-01T00:00:00.000Z',
      projectId: 'project-1',
    },
    ...overrides,
  }
}

describe('toDormancyAlertViews (AC-4)', () => {
  it('maps a machine_key.dormant alert into a view with machine user/key/last-used', () => {
    const result = toDormancyAlertViews([alert()])
    expect(result).toEqual([
      {
        id: 'alert-1',
        machineUserId: 'mu-1',
        machineUserName: 'ci-deploy-bot',
        keyId: 'key-1',
        keyName: 'prod-key',
        lastUsedAt: '2026-05-01T00:00:00.000Z',
        projectId: 'project-1',
        createdAt: '2026-07-01T00:00:00.000Z',
      },
    ])
  })

  it('excludes non-machine_key.dormant alert types', () => {
    const result = toDormancyAlertViews([alert({ alertType: 'security.failed_auth_threshold' })])
    expect(result).toEqual([])
  })

  it('excludes already-dismissed alerts', () => {
    const result = toDormancyAlertViews([alert({ status: 'dismissed' })])
    expect(result).toEqual([])
  })

  it('handles a null lastUsedAt (key never used)', () => {
    const result = toDormancyAlertViews([
      alert({ payload: { ...alert().payload, lastUsedAt: null } }),
    ])
    expect(result[0]?.lastUsedAt).toBeNull()
  })

  it('safely drops a malformed payload instead of throwing', () => {
    const result = toDormancyAlertViews([alert({ payload: { keyId: 'key-1' } })])
    expect(result).toEqual([])
  })
})
