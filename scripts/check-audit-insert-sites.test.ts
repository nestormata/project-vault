import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findUnallowlistedInsertSites } from './check-audit-insert-sites.js'

describe('Story 22.1 AC-13/AC-30 #18: check-audit-insert-sites', () => {
  let dir: string | undefined

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('finds no offenders against the real repository tree (the allowlist matches the live nine sites)', () => {
    const repoRoot = join(import.meta.dirname, '..')
    expect(findUnallowlistedInsertSites(repoRoot)).toEqual([])
  })

  it('catches a deliberately-added ninth insert site using the Drizzle idiom', () => {
    dir = mkdtempSync(join(tmpdir(), 'audit-insert-guard-drizzle-'))
    mkdirSync(join(dir, 'apps', 'api', 'src', 'modules', 'fixture'), { recursive: true })
    writeFileSync(
      join(dir, 'apps', 'api', 'src', 'modules', 'fixture', 'rogue-writer.ts'),
      "await tx.insert(auditLogEntries).values({ orgId, eventType: 'x' })\n"
    )
    const offenders = findUnallowlistedInsertSites(dir)
    expect(offenders).toEqual(['apps/api/src/modules/fixture/rogue-writer.ts'])
  })

  it('catches a deliberately-added ninth insert site using the raw-SQL idiom', () => {
    dir = mkdtempSync(join(tmpdir(), 'audit-insert-guard-rawsql-'))
    mkdirSync(join(dir, 'packages', 'db', 'src', 'fixture'), { recursive: true })
    writeFileSync(
      join(dir, 'packages', 'db', 'src', 'fixture', 'rogue-writer.ts'),
      'await tx.execute(sql`INSERT INTO audit_log_entries (org_id) VALUES (${orgId})`)\n'
    )
    const offenders = findUnallowlistedInsertSites(dir)
    expect(offenders).toEqual(['packages/db/src/fixture/rogue-writer.ts'])
  })

  it('never flags a *.test.ts fixture file, even if it inserts directly', () => {
    dir = mkdtempSync(join(tmpdir(), 'audit-insert-guard-testfile-'))
    mkdirSync(join(dir, 'apps', 'api', 'src', 'modules', 'fixture'), { recursive: true })
    writeFileSync(
      join(dir, 'apps', 'api', 'src', 'modules', 'fixture', 'rogue-writer.test.ts'),
      "await tx.insert(auditLogEntries).values({ orgId, eventType: 'x' })\n"
    )
    expect(findUnallowlistedInsertSites(dir)).toEqual([])
  })
})
