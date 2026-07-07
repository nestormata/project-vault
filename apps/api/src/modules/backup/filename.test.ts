import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getDb } from '@project-vault/db'
import { backupRuns } from '@project-vault/db/schema'
import { buildBackupFilenames, parseBackupFilename, resolveInstanceId } from './filename.js'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'

describe('Story 9.1 D2: backup filename scheme', () => {
  it('builds a filename + meta sidecar in the documented format', () => {
    const instanceId = randomUUID()
    const { filename, metaFilename } = buildBackupFilenames(
      new Date('2026-07-05T03:00:00.000Z'),
      instanceId
    )
    expect(filename).toBe(`backup_20260705T030000000Z_${instanceId}.vault`)
    expect(metaFilename).toBe(`backup_20260705T030000000Z_${instanceId}.meta.json`)
  })

  it('round-trips through parseBackupFilename', () => {
    const built = buildBackupFilenames(new Date('2026-07-04T03:00:00.000Z'), randomUUID())
    const parsed = parseBackupFilename(built.filename)
    expect(parsed).not.toBeNull()
    expect(parsed?.timestamp).toBe('20260704T030000000Z')
  })

  it('returns null for a filename that does not match the scheme', () => {
    expect(parseBackupFilename('not-a-backup-file.txt')).toBeNull()
  })

  it("resolveInstanceId reuses the most recent backup_runs row's instanceId (AC-5 D2)", async () => {
    const instanceId = randomUUID()
    const { filename } = buildBackupFilenames(new Date(), instanceId)
    await getDb()
      .insert(backupRuns)
      .values({ filename, status: 'succeeded', triggeredBy: 'manual' })

    const resolved = await resolveInstanceId()
    expect(resolved).toBe(instanceId)
  })
})
