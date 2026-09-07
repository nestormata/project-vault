import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const MIGRATION_PATH = resolve(
  import.meta.dirname,
  '../migrations/0093_notification_queue_origin_extension_name.sql'
)

describe('migration 0093 safety', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8')

  it('adds exactly one additive, nullable column and one partial index, nothing else', () => {
    expect(sql.match(/ADD COLUMN/g)).toHaveLength(1)
    expect(sql).toMatch(/ADD COLUMN "origin_extension_name" text/)
    // No NOT NULL / DEFAULT — every existing row stays byte-identical (implicit NULL).
    expect(sql).not.toMatch(/"origin_extension_name" text NOT NULL/)
    expect(sql).not.toMatch(/"origin_extension_name" text DEFAULT/)
    expect(sql).not.toMatch(/DROP COLUMN|DROP TABLE|RENAME|TRUNCATE|DELETE FROM/i)
  })

  it('creates the rate-limit covering index, partial WHERE origin_extension_name IS NOT NULL', () => {
    expect(sql.match(/CREATE INDEX/g)).toHaveLength(1)
    expect(sql).toMatch(
      /CREATE INDEX "idx_notification_queue_origin_extension_rate_limit" ON "notification_queue" USING btree \("origin_extension_name","org_id","created_at"\)/
    )
    expect(sql).toMatch(/WHERE "notification_queue"\."origin_extension_name" IS NOT NULL/)
  })

  it('does not touch any other table', () => {
    const alterTableTargets = [...sql.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1])
    expect(new Set(alterTableTargets)).toEqual(new Set(['notification_queue']))
  })
})
