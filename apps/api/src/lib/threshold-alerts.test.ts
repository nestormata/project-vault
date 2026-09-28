import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { adminAlerts } from '@project-vault/db/schema'
import {
  clearThresholdAlertEpisode,
  listActiveThresholdAlertScopeKeys,
  upsertThresholdAlert,
} from './threshold-alerts.js'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'

describe('Story 9.2 threshold-alert episode idempotency', () => {
  it('creates a new alert on first crossing, does not re-fire at the same threshold, fires again on a higher threshold', async () => {
    const alertType = `test.threshold.${randomUUID()}`

    const first = await upsertThresholdAlert({
      alertType,
      thresholdPct: 80,
      severity: 'warning',
      payload: { current: 40, limit: 50 },
      scopeKey: null,
    })
    expect(first).not.toBeNull()

    const repeat = await upsertThresholdAlert({
      alertType,
      thresholdPct: 80,
      severity: 'warning',
      payload: { current: 41, limit: 50 },
      scopeKey: null,
    })
    expect(repeat).toBeNull()

    const escalated = await upsertThresholdAlert({
      alertType,
      thresholdPct: 95,
      severity: 'critical',
      payload: { current: 48, limit: 50 },
      scopeKey: null,
    })
    expect(escalated).not.toBeNull()
    expect(escalated?.id).not.toBe(first?.id)

    const activeRows = await getDb()
      .select({ id: adminAlerts.id, status: adminAlerts.status })
      .from(adminAlerts)
      .where(eq(adminAlerts.alertType, alertType))
    expect(activeRows.filter((r) => r.status === 'active')).toHaveLength(1)
  })

  it('scopes episodes independently per scopeKey (per-org alerts, AC-13)', async () => {
    const alertType = `test.threshold.scoped.${randomUUID()}`
    const orgA = randomUUID()
    const orgB = randomUUID()

    const alertA = await upsertThresholdAlert({
      alertType,
      thresholdPct: 80,
      severity: 'warning',
      payload: {},
      scopeKey: orgA,
    })
    const alertB = await upsertThresholdAlert({
      alertType,
      thresholdPct: 80,
      severity: 'warning',
      payload: {},
      scopeKey: orgB,
    })
    expect(alertA).not.toBeNull()
    expect(alertB).not.toBeNull()
    expect(alertA?.id).not.toBe(alertB?.id)
  })

  it('clearThresholdAlertEpisode allows a fresh alert to fire after re-crossing (AC-13 edge case)', async () => {
    const alertType = `test.threshold.reset.${randomUUID()}`
    await upsertThresholdAlert({
      alertType,
      thresholdPct: 80,
      severity: 'warning',
      payload: {},
      scopeKey: null,
    })
    await clearThresholdAlertEpisode(alertType, null)
    const reCrossed = await upsertThresholdAlert({
      alertType,
      thresholdPct: 80,
      severity: 'warning',
      payload: {},
      scopeKey: null,
    })
    expect(reCrossed).not.toBeNull()
  })
})

describe('Story 56.2 AC4c listActiveThresholdAlertScopeKeys', () => {
  it('lists only the active, scope-keyed episodes of the given alert type', async () => {
    const alertType = `test.threshold.list.${randomUUID()}`
    const otherType = `test.threshold.list.other.${randomUUID()}`
    const base = { thresholdPct: 80 as const, severity: 'warning' as const, payload: {} }

    await upsertThresholdAlert({ ...base, alertType, scopeKey: 'com.acme.example/probe-sweep' })
    await upsertThresholdAlert({ ...base, alertType, scopeKey: 'com.acme.example/cert-sweep' })
    await upsertThresholdAlert({ ...base, alertType, scopeKey: 'com.acme.example/cleared' })
    await clearThresholdAlertEpisode(alertType, 'com.acme.example/cleared')
    await upsertThresholdAlert({ ...base, alertType, scopeKey: null })
    await upsertThresholdAlert({ ...base, alertType: otherType, scopeKey: 'com.acme.other/x' })

    const keys = await listActiveThresholdAlertScopeKeys(alertType)
    expect([...keys].sort()).toEqual([
      'com.acme.example/cert-sweep',
      'com.acme.example/probe-sweep',
    ])
  })

  it('returns an empty list when nothing is active for the type', async () => {
    expect(await listActiveThresholdAlertScopeKeys(`test.threshold.none.${randomUUID()}`)).toEqual(
      []
    )
  })
})
