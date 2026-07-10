import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIGRATION_PATH = resolve(
  import.meta.dirname,
  '../migrations/0047_notification_preference_none_channel.sql'
)

describe('migration 0047 safety', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8')

  it('only rewrites the notification_preferences channel check to add none', () => {
    expect(sql.match(/DROP CONSTRAINT/g)).toHaveLength(1)
    expect(sql.match(/ADD CONSTRAINT/g)).toHaveLength(1)
    expect(sql).toMatch(/DROP CONSTRAINT "notification_preferences_channel_check"/)
    expect(sql).toMatch(
      /CHECK \("notification_preferences"\."channel" IN \('email', 'slack', 'inbox', 'none'\)\)/
    )
    expect(sql).not.toMatch(/DROP COLUMN|DROP TABLE|ALTER COLUMN|DELETE FROM|TRUNCATE/i)
  })
})
