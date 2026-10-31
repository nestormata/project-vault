import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  findDestructiveStatements,
  KNOWN_REVIEWED_DESTRUCTIVE_MIGRATIONS,
} from '../lib/migration-safety.js'
import { scanPendingForDestructive } from '../scripts/guarded-migrate.js'
import { EXCLUDED_TABLES } from '../check-rls-coverage.js'
import * as schema from '../schema/index.js'

const TAG = '0109_drop_handoff_pending_states'
const MIGRATION_PATH = resolve(import.meta.dirname, `../migrations/${TAG}.sql`)

// Story 73.1 D7: the registry entry lets the guarded migrator apply this drop in place, so the
// file must stay exactly one DROP TABLE of the retired table.
describe('migration 0109 safety', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8')
  const statements = sql.replaceAll(/^\s*--.*$/gm, '').trim()

  it('is registered as a reviewed destructive migration', () => {
    expect(KNOWN_REVIEWED_DESTRUCTIVE_MIGRATIONS).toHaveProperty(TAG)
    expect(findDestructiveStatements(sql)).not.toEqual([])
    expect(scanPendingForDestructive([{ tag: TAG, sql, folderMillis: 0 }])).toEqual([])
  })

  it('drops exactly handoff_pending_states, without CASCADE, and nothing else', () => {
    expect(statements).toBe('DROP TABLE "handoff_pending_states";')
  })

  it('leaves no schema declaration or RLS exclusion behind for the dropped table', () => {
    expect(schema).not.toHaveProperty('handoffPendingStates')
    expect(EXCLUDED_TABLES.has('handoff_pending_states')).toBe(false)
  })
})
