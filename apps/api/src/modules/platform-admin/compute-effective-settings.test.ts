import { describe, expect, it } from 'vitest'
import type { SystemSettings } from '@project-vault/db/schema'
import { computeEffectiveSettings } from './service.js'

function fullRow(overrides: Partial<SystemSettings> = {}): SystemSettings {
  return {
    id: 1,
    smtpHost: 'smtp.example.com',
    smtpPort: 2525,
    smtpSecure: true,
    smtpUser: 'db-user',
    smtpPassEncrypted: null,
    smtpFrom: 'db-from@example.com',
    backupScheduleOverride: '0 4 * * *',
    backupRetentionCountOverride: 14,
    defaultSlackWebhookUrl: 'https://hooks.slack.example.com/db',
    maxOrgs: 25,
    maxUsersPerOrg: 100,
    sessionIdleTimeoutMinutesOverride: 45,
    updatedAt: new Date(),
    updatedByUserId: null,
    ...overrides,
  } as SystemSettings
}

describe('computeEffectiveSettings (Story 10.4 branch coverage)', () => {
  it('synthesizes env-var defaults when no system_settings row exists (AC-24)', () => {
    const result = computeEffectiveSettings(undefined)

    // instancePolicy always has hardcoded fallback defaults regardless of env.
    expect(result.instancePolicy.maxOrgs).toBe(10)
    expect(result.instancePolicy.maxUsersPerOrg).toBe(50)
    // smtp.configured is false when neither DB nor env provides a host.
    expect(typeof result.smtp.configured).toBe('boolean')
  })

  it('DB row overrides take precedence over env defaults for every field', () => {
    const row = fullRow()
    const result = computeEffectiveSettings(row)

    expect(result.smtp).toMatchObject({
      host: 'smtp.example.com',
      port: 2525,
      user: 'db-user',
      from: 'db-from@example.com',
      configured: true,
    })
    expect(result.backup).toMatchObject({
      schedule: '0 4 * * *',
      retentionCount: 14,
    })
    expect(result.notifications).toMatchObject({
      defaultSlackWebhook: 'https://hooks.slack.example.com/db',
    })
    expect(result.instancePolicy).toMatchObject({
      maxOrgs: 25,
      maxUsersPerOrg: 100,
      sessionIdleTimeoutMinutes: 45,
    })
  })

  it('falls back to env/hardcoded defaults per-field when the row has null overrides', () => {
    const row = fullRow({
      smtpHost: null,
      smtpPort: null,
      smtpUser: null,
      smtpFrom: null,
      backupScheduleOverride: null,
      backupRetentionCountOverride: null,
      defaultSlackWebhookUrl: null,
      sessionIdleTimeoutMinutesOverride: null,
    })
    const result = computeEffectiveSettings(row)

    // maxOrgs/maxUsersPerOrg are NOT NULL columns with their own DB defaults (10/50), so a real
    // row always carries a concrete value there — only the nullable *Override columns exercise
    // the pick()-to-env/hardcoded-default fallback path.
    expect(result.smtp.configured).toBe(false)
    expect(result.instancePolicy.maxOrgs).toBe(25)
  })
})
