import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIGRATION_PATH = resolve(
  import.meta.dirname,
  '../migrations/0101_notification_queue_claim_expires_at.sql'
)

// Story 70.1 AC7 — the claim-lease/send-marker migration is purely additive.
describe('migration 0101 safety', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8')
  const statements = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--') && line.trim().length > 0)
    .join('\n')

  it('adds exactly the two nullable timestamptz columns and nothing else', () => {
    expect(statements.split('--> statement-breakpoint').map((s) => s.trim())).toEqual([
      'ALTER TABLE "notification_queue" ADD COLUMN "claim_expires_at" timestamp with time zone;',
      'ALTER TABLE "notification_queue" ADD COLUMN "send_started_at" timestamp with time zone;',
    ])
    expect(statements).not.toMatch(/NOT NULL|DEFAULT|GRANT|POLICY|INDEX|UPDATE |DROP /i)
  })
})
