import { randomUUID } from 'node:crypto'
import { desc } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { backupRuns } from '@project-vault/db/schema'

const UUID_PATTERN = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
// Millisecond precision (not just whole seconds) — two backups triggered in rapid succession
// (e.g. a manual trigger immediately after a scheduled one completes) must never collide on the
// `backup_runs.filename` unique constraint.
const FILENAME_PATTERN = /^backup_(\d{8}T\d{9}Z)_([0-9a-f-]+)\.vault$/i

/**
 * Story 9.1 D2 (deviation from epics.md:2017 — orgId → instanceId): backup is whole-instance, not
 * per-org, so the `_<orgId>` filename component is replaced with `_<instanceId>` — a random UUID
 * generated once (on the very first backup this instance ever takes) and thereafter kept
 * consistent by reading it back out of the most recent existing `backup_runs.filename` row,
 * rather than a dedicated column — this purely disambiguates backups from multiple separate
 * self-hosted instances if an operator points several deployments at the same shared S3 bucket.
 */
export async function resolveInstanceId(): Promise<string> {
  const [latest] = await getDb()
    .select({ filename: backupRuns.filename })
    .from(backupRuns)
    .orderBy(desc(backupRuns.startedAt))
    .limit(1)

  const match = latest ? UUID_PATTERN.exec(latest.filename) : null
  return match?.[1] ?? randomUUID()
}

function compactIso(date: Date): string {
  // e.g. "2026-07-05T03:00:00.123Z" -> "20260705T030000123Z" (millisecond precision retained —
  // see FILENAME_PATTERN comment above for why whole-second granularity isn't safe enough).
  return date.toISOString().replace(/[-:.]/g, '')
}

export function buildBackupFilenames(
  timestamp: Date,
  instanceId: string
): { filename: string; metaFilename: string } {
  const base = `backup_${compactIso(timestamp)}_${instanceId}`
  return { filename: `${base}.vault`, metaFilename: `${base}.meta.json` }
}

/** Derives the `.meta.json` sidecar filename from a `.vault` filename — shared by every call
 * site in service.ts that needs to read/write the sidecar alongside the encrypted backup file. */
export function metaFilenameFor(filename: string): string {
  return filename.replace(/\.vault$/, '.meta.json')
}

export function parseBackupFilename(
  filename: string
): { timestamp: string; instanceId: string } | null {
  const match = FILENAME_PATTERN.exec(filename)
  if (!match) return null
  const [, timestamp, instanceId] = match
  if (!timestamp || !instanceId) return null
  return { timestamp, instanceId }
}
