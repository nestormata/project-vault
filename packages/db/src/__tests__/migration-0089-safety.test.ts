import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIGRATION_PATH = resolve(import.meta.dirname, '../migrations/0089_sturdy_calypso.sql')

describe('migration 0089 safety', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8')

  it('only rewrites notification_queue_status_check to widen it, no other destructive statement', () => {
    expect(sql.match(/DROP CONSTRAINT/g)).toHaveLength(1)
    expect(sql.match(/ADD CONSTRAINT/g)).toHaveLength(1)
    expect(sql).toMatch(/DROP CONSTRAINT "notification_queue_status_check"/)
    expect(sql).toMatch(
      /CHECK \("notification_queue"\."status" IN \('pending','sent','delivered','bounced','failed','suppressed'\)\)/
    )
    expect(sql).not.toMatch(/DROP COLUMN|DROP TABLE|RENAME|TRUNCATE|DELETE FROM/i)
  })

  it('retains every pre-existing allowed status value (additive-only widening)', () => {
    const match = sql.match(/CHECK \("notification_queue"\."status" IN \(([^)]+)\)\)/)
    expect(match).not.toBeNull()
    const values = (match?.[1] ?? '').split(',').map((v) => v.trim())
    expect(values).toEqual(
      expect.arrayContaining(["'pending'", "'delivered'", "'failed'", "'suppressed'"])
    )
    expect(values).toContain("'sent'")
    expect(values).toContain("'bounced'")
  })

  it('does not touch any other table', () => {
    const alterTableTargets = [...sql.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1])
    expect(new Set(alterTableTargets)).toEqual(new Set(['notification_queue']))
  })

  it('adds only the three new columns and the provider-message unique index, nothing else', () => {
    expect(sql.match(/ADD COLUMN/g)).toHaveLength(3)
    expect(sql).toMatch(/ADD COLUMN "provider_id" text/)
    expect(sql).toMatch(/ADD COLUMN "provider_message_id" text/)
    expect(sql).toMatch(/ADD COLUMN "last_event_at" timestamp with time zone/)
    expect(sql).toMatch(/CREATE UNIQUE INDEX "idx_notification_queue_provider_message_id"/)
  })
})
