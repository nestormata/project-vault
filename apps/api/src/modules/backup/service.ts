import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { and, desc, eq, sql } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { backupRuns, vaultState } from '@project-vault/db/schema'
import { runBackupCrypto, BackupDecryptError } from '@project-vault/crypto'
import { getBackupKey } from '../vault/key-service.js'
import { zeroKeys } from '../vault/key-service.js'
import { env } from '../../config/env.js'
import { resolveBackupDestination, requireBackupDatabaseUrl } from './config.js'
import {
  buildBackupFilenames,
  metaFilenameFor,
  parseBackupFilename,
  resolveInstanceId,
} from './filename.js'
import { runPgDump, runPgRestore } from './pg-process.js'
import { backupStorageFor, type BackupStorage } from './storage.js'
import {
  assetsPresentFromTables,
  extractTableNames,
  type BackupAssetsPresent,
} from './dump-inspect.js'

const BACKUP_ADVISORY_LOCK_KEY = 'backup:snapshot'

export type BackupTrigger = 'schedule' | 'manual'

export type AcquireBackupSlotResult =
  | { ok: true; runId: string; filename: string; metaFilename: string }
  | { ok: false; runningSince: string | null; jobId: string | null }

export type BackupListItem = {
  filename: string
  timestamp: string
  sizeBytes: number | null
  keyVersion: number | null
  verified: 'unverified' | 'valid' | 'invalid'
}

export type BackupServiceDeps = {
  dump?: (connectionString: string) => Promise<Buffer>
  restore?: (connectionString: string, sql: Buffer) => Promise<void>
  storage?: BackupStorage
}

function defaultStorage(): BackupStorage {
  const destination = resolveBackupDestination()
  if (!destination) throw new Error('defaultStorage: no backup destination configured')
  return backupStorageFor(destination)
}

/**
 * Code review fix: `acquireBackupSlot`'s advisory lock only ever guards the brief
 * check-then-insert critical section — the long-lived `status: 'running'` row is the real
 * concurrency marker future triggers check against (see doc comment below). If the process
 * crashes or is force-restarted while a backup is mid-flight (after the row is inserted but
 * before `executeBackupSnapshot`'s own try/catch reaches a `succeeded`/`failed` update), that row
 * is orphaned forever — nothing else in this codebase ever un-sticks it, which would otherwise
 * permanently 409 every future manual trigger and silently no-op every future scheduled fire
 * (backup-snapshot.ts's `if (!acquired.ok) return`). Call once at process startup (main.ts, on
 * the same `onVaultUnsealed` hook that wires the rest of backup scheduling): any row still
 * `running` at that point can only be orphaned, because pg-boss itself restarts fresh on every
 * process boot, so no in-flight execution context for it can possibly still exist.
 */
export async function reconcileStaleRunningBackups(): Promise<number> {
  const reconciled = await getDb()
    .update(backupRuns)
    .set({
      status: 'failed',
      completedAt: new Date(),
      errorMessage:
        'Orphaned: this backup_runs row was still "running" when a new process started — the ' +
        'previous process most likely crashed or was force-restarted mid-backup.',
    })
    .where(eq(backupRuns.status, 'running'))
    .returning({ id: backupRuns.id })
  return reconciled.length
}

/**
 * Story 9.1 AC-7: atomically checks "is a backup already running" and, if not, inserts the
 * `backup_runs` row (status: 'running') that IS the concurrency marker for every future check —
 * an `pg_try_advisory_xact_lock` guards only this brief check-then-insert critical section
 * against a genuine simultaneous race between two trigger calls (or a scheduled fire coinciding
 * with a manual one); it is released the instant this transaction commits. The actual
 * dump/encrypt/upload pipeline that follows runs asynchronously and updates this same row when it
 * finishes — the row's `status = 'running'` existence (not the lock) is what a later concurrent
 * trigger attempt sees and rejects on.
 */
export async function acquireBackupSlot(trigger: {
  triggeredBy: BackupTrigger
  triggeredByUserId?: string | null
}): Promise<AcquireBackupSlotResult> {
  return getDb().transaction(async (tx) => {
    const lockRows = await tx.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(hashtext(${BACKUP_ADVISORY_LOCK_KEY})) AS locked`
    )
    const acquired = Boolean(lockRows[0]?.locked)
    if (!acquired) {
      return { ok: false, runningSince: null, jobId: null }
    }

    const [existingRunning] = await tx
      .select({ filename: backupRuns.filename, startedAt: backupRuns.startedAt, id: backupRuns.id })
      .from(backupRuns)
      .where(eq(backupRuns.status, 'running'))
      .limit(1)
    if (existingRunning) {
      return {
        ok: false,
        runningSince: existingRunning.startedAt.toISOString(),
        jobId: existingRunning.id,
      }
    }

    const instanceId = await resolveInstanceId()
    const { filename, metaFilename } = buildBackupFilenames(new Date(), instanceId)
    const [inserted] = await tx
      .insert(backupRuns)
      .values({
        filename,
        status: 'running',
        triggeredBy: trigger.triggeredBy,
        triggeredByUserId: trigger.triggeredByUserId ?? null,
      })
      .returning({ id: backupRuns.id })
    if (!inserted) throw new Error('acquireBackupSlot: insert returned no row')

    return { ok: true, runId: inserted.id, filename, metaFilename }
  })
}

async function currentVaultKeyVersion(): Promise<number | null> {
  const [row] = await getDb()
    .select({ keyVersion: vaultState.keyVersion })
    .from(vaultState)
    .limit(1)
  return row?.keyVersion ?? null
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function buildMetaJson(input: {
  timestamp: string
  keyVersion: number | null
  tables: string[]
  checksumSha256: string
}): Buffer {
  return Buffer.from(
    JSON.stringify(
      {
        vaultVersion: env.SERVICE_NAME,
        timestamp: input.timestamp,
        keyVersion: input.keyVersion,
        tables: input.tables,
        checksumSha256: input.checksumSha256,
      },
      null,
      2
    )
  )
}

/**
 * Story 9.1 AC-5/AC-6: executes the actual dump → gzip → worker-thread encrypt → destination
 * write pipeline for a slot already reserved by `acquireBackupSlot`. Updates the `backup_runs`
 * row to `succeeded` or `failed` — callers (the `backup:snapshot` worker) are responsible for
 * enqueueing the `backup.failure` alert on a thrown error (D7/AC-13), since alert delivery needs
 * the full notification/boss wiring this module intentionally doesn't depend on.
 */
export async function executeBackupSnapshot(
  run: { runId: string; filename: string; metaFilename: string },
  deps: BackupServiceDeps = {}
): Promise<{ sizeBytes: number; checksumSha256: string; durationMs: number }> {
  const start = Date.now()
  const dump = deps.dump ?? runPgDump
  const storage = deps.storage ?? defaultStorage()

  try {
    const plainSql = await dump(requireBackupDatabaseUrl())
    const gzipped = gzipSync(plainSql)
    const encrypted = await runBackupCrypto('encrypt', gzipped, getBackupKey())
    const checksumSha256 = sha256Hex(encrypted)
    const keyVersion = await currentVaultKeyVersion()
    const tables = [...extractTableNames(plainSql.toString('utf8'))].sort()

    // AC-5: write the encrypted file first, then the sidecar — if the process crashes between
    // the two, a `.vault` with no sidecar is a detectable, safe partial state (validate/restore
    // will fail loudly), never the reverse (a sidecar promising a backup that doesn't exist).
    await storage.write(run.filename, encrypted)
    await storage.write(
      run.metaFilename,
      buildMetaJson({
        timestamp: new Date().toISOString(),
        keyVersion,
        tables,
        checksumSha256,
      })
    )

    await getDb()
      .update(backupRuns)
      .set({
        status: 'succeeded',
        completedAt: new Date(),
        sizeBytes: encrypted.length,
        keyVersion,
        checksumSha256,
      })
      .where(eq(backupRuns.id, run.runId))

    return { sizeBytes: encrypted.length, checksumSha256, durationMs: Date.now() - start }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await getDb()
      .update(backupRuns)
      .set({ status: 'failed', completedAt: new Date(), errorMessage: message })
      .where(eq(backupRuns.id, run.runId))
    throw error
  }
}

export async function listBackups(): Promise<BackupListItem[]> {
  const rows = await getDb()
    .select({
      filename: backupRuns.filename,
      startedAt: backupRuns.startedAt,
      sizeBytes: backupRuns.sizeBytes,
      keyVersion: backupRuns.keyVersion,
      verified: backupRuns.verified,
    })
    .from(backupRuns)
    .orderBy(desc(backupRuns.startedAt))

  return rows.map((row) => ({
    filename: row.filename,
    timestamp: row.startedAt.toISOString(),
    sizeBytes: row.sizeBytes,
    keyVersion: row.keyVersion,
    verified: row.verified as 'unverified' | 'valid' | 'invalid',
  }))
}

async function readMetaSidecar(
  storage: BackupStorage,
  metaFilename: string
): Promise<{ checksumSha256: string } | null> {
  try {
    const raw = await storage.read(metaFilename)
    return JSON.parse(raw.toString('utf8')) as { checksumSha256: string }
  } catch {
    return null
  }
}

export type RestoreOutcome =
  | { code: 'not_found' }
  | { code: 'checksum_mismatch' }
  | { code: 'decrypt_failed' }
  | { code: 'restored' }
  | { code: 'restore_failed'; message: string }

/**
 * Split out of `restoreFromBackup` purely to keep that function's cyclomatic complexity within
 * this repo's eslint threshold (same discipline as `backup-health-check.ts`'s
 * `raiseBackupMissedAlert`). Decrypts, runs the restore, and seals the vault on success.
 *
 * Code review fix: the pg_restore/psql subprocess call previously had no failure handling at all
 * — a thrown `PgProcessError` (or a `VaultSealedError` from a racing concurrent restore/zeroKeys)
 * propagated uncaught past `restoreFromBackup` into the route handler, which also had no
 * try/catch, producing a generic unhandled 500 with zero operational-log trace (violates AC-18's
 * blanket "any backup/restore action... failure... emits a structured operational log entry").
 * Reported as a distinct outcome instead so the caller can log + respond deliberately.
 */
async function decryptAndRestore(
  encrypted: Buffer,
  restore: NonNullable<BackupServiceDeps['restore']>
): Promise<RestoreOutcome> {
  let plainSql: Buffer
  try {
    const gzipped = await runBackupCrypto('decrypt', encrypted, getBackupKey())
    plainSql = gunzipSync(gzipped)
  } catch (error) {
    if (error instanceof BackupDecryptError) return { code: 'decrypt_failed' }
    throw error
  }

  try {
    await restore(requireBackupDatabaseUrl(), plainSql)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { code: 'restore_failed', message }
  }

  // AC-9: seal the vault after a destructive restore — same seal semantics as Story 1.5.
  zeroKeys()

  return { code: 'restored' }
}

/**
 * Story 9.1 AC-9: decrypts, verifies the sidecar checksum BEFORE any restore is attempted, runs
 * the restore against BACKUP_DATABASE_URL, then seals the vault — matching Story 1.5's existing
 * seal semantics exactly (manual unseal required afterward).
 */
export async function restoreFromBackup(
  filename: string,
  deps: BackupServiceDeps = {}
): Promise<RestoreOutcome> {
  // Code review fix (path traversal / CWE-22): `filename` originates directly from the
  // `:filename` route param (`BackupFilenameParamsSchema` only enforces non-empty, not shape),
  // and `storage.ts`'s filesystem backend joins it onto `BACKUP_STORAGE_PATH` with no
  // sanitization. Reject anything that isn't a real, well-formed backup filename BEFORE it ever
  // reaches storage.read/delete — treated the same as AC-9's "unknown filename" 404 case, since a
  // path-traversal payload can never be a legitimate backup filename anyway.
  if (!parseBackupFilename(filename)) {
    return { code: 'not_found' }
  }

  const storage = deps.storage ?? defaultStorage()
  const restore = deps.restore ?? runPgRestore
  const metaFilename = metaFilenameFor(filename)

  let encrypted: Buffer
  try {
    encrypted = await storage.read(filename)
  } catch {
    return { code: 'not_found' }
  }

  const meta = await readMetaSidecar(storage, metaFilename)
  const actualChecksum = sha256Hex(encrypted)
  if (!meta || meta.checksumSha256 !== actualChecksum) {
    return { code: 'checksum_mismatch' }
  }

  return decryptAndRestore(encrypted, restore)
}

export type ValidateOutcome = {
  valid: boolean
  assetsPresent: BackupAssetsPresent
  checksumMatches: boolean
}

/** AC-10: "backup_runs.verified is updated to 'valid'/'invalid' for this filename as a side
 * effect" — a no-op if the filename has no matching row (e.g. a file that exists on the storage
 * destination but was never recorded, which shouldn't happen in practice but must not throw). */
export async function updateBackupVerifiedStatus(
  filename: string,
  verified: 'valid' | 'invalid'
): Promise<void> {
  await getDb().update(backupRuns).set({ verified }).where(eq(backupRuns.filename, filename))
}

/**
 * Story 9.1 AC-10: isolated, read-only, non-destructive validation. Decrypts the backup and
 * performs structural inspection of the decompressed SQL text (`extractTableNames`) — this never
 * opens a connection to, or executes anything against, the live database the running instance
 * actually serves (one of the two acceptable approaches AC-10 documents; the other being a
 * throwaway temporary database restore, not implemented in this story).
 */
export async function validateBackupFile(
  filename: string,
  deps: BackupServiceDeps = {}
): Promise<ValidateOutcome> {
  const invalidResult: ValidateOutcome = {
    valid: false,
    assetsPresent: { credentials: false, projects: false, users: false, auditEvents: false },
    checksumMatches: false,
  }

  // Code review fix (path traversal / CWE-22): see the matching guard in `restoreFromBackup`
  // above — reject anything that isn't a well-formed backup filename before it ever reaches
  // storage.read, which joins this value directly onto BACKUP_STORAGE_PATH with no sanitization.
  if (!parseBackupFilename(filename)) {
    return invalidResult
  }

  const storage = deps.storage ?? defaultStorage()
  const metaFilename = metaFilenameFor(filename)

  let encrypted: Buffer
  try {
    encrypted = await storage.read(filename)
  } catch {
    return invalidResult
  }

  const meta = await readMetaSidecar(storage, metaFilename)
  const actualChecksum = sha256Hex(encrypted)
  const checksumMatches = Boolean(meta && meta.checksumSha256 === actualChecksum)
  if (!checksumMatches) return { ...invalidResult, checksumMatches: false }

  try {
    const gzipped = await runBackupCrypto('decrypt', encrypted, getBackupKey())
    const plainSql = gunzipSync(gzipped)
    const tables = extractTableNames(plainSql.toString('utf8'))
    const assetsPresent = assetsPresentFromTables(tables)
    const valid = Object.values(assetsPresent).every(Boolean)
    return { valid, assetsPresent, checksumMatches: true }
  } catch {
    return invalidResult
  }
}

/**
 * Story 9.1 AC-11: retention pruning — only `succeeded` backups are eligible (a `running` backup
 * can never be pruned mid-write); keeps the N most recent, deletes the physical file (+ sidecar)
 * for the rest while retaining the `backup_runs` row for audit/history (so `GET /admin/backups`
 * can still show "this backup existed but was pruned" — chosen over deleting the row, per AC-11's
 * documented recommendation).
 */
export async function pruneOldBackups(
  deps: BackupServiceDeps = {}
): Promise<{ prunedFilenames: string[] }> {
  const storage = deps.storage ?? defaultStorage()
  const retentionCount = env.BACKUP_RETENTION_COUNT

  const succeeded = await getDb()
    .select({ id: backupRuns.id, filename: backupRuns.filename })
    .from(backupRuns)
    .where(eq(backupRuns.status, 'succeeded'))
    .orderBy(desc(backupRuns.startedAt))

  const toPrune = succeeded.slice(retentionCount)
  const prunedFilenames: string[] = []
  for (const row of toPrune) {
    const metaFilename = metaFilenameFor(row.filename)
    await storage.delete(row.filename)
    await storage.delete(metaFilename)
    prunedFilenames.push(row.filename)
  }
  return { prunedFilenames }
}

/** AC-12: last succeeded backup's completion time, or null if none has ever succeeded. */
export async function lastSuccessfulBackupAt(): Promise<Date | null> {
  const [row] = await getDb()
    .select({ completedAt: backupRuns.completedAt })
    .from(backupRuns)
    .where(and(eq(backupRuns.status, 'succeeded')))
    .orderBy(desc(backupRuns.startedAt))
    .limit(1)
  return row?.completedAt ?? null
}
