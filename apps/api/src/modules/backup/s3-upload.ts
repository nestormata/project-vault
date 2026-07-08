import { readdir, rm, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3'
import { env } from '../../config/env.js'
import { atomicFileWrite } from './atomic-write.js'

const DEFAULT_STAGING_DIRNAME = 'vault-backup-staging'
const STAGED_SUFFIX = '.staged'
const MAX_ATTEMPTS = 3
// D3.14 (adversarial review, low, documented trade-off): no jitter — acceptable for this
// codebase's single-instance, self-hosted target deployment shape (no thundering-herd risk).
const BACKOFF_MS = [500, 1500] as const
const ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Story 9.6 D3.1/AC-18: resolves the local staging directory for the S3 destination — an
 * operator-configured `BACKUP_S3_STAGING_PATH`, or an `os.tmpdir()`-based default (does NOT
 * survive a container restart; see `.env.example`'s comment). Resolved here, at the storage
 * layer, not in env validation — an unset value is not a startup error.
 */
export function resolveStagingPath(): string {
  return env.BACKUP_S3_STAGING_PATH || join(tmpdir(), DEFAULT_STAGING_DIRNAME)
}

/** AC-16's edge case: the cleanup/usage scans below match strictly on this literal suffix — never
 * a real `.vault`/`.meta.json` blob (those live at the S3 destination, not in this directory, by
 * construction) or any unrelated file an operator happens to drop in the staging directory. */
export function stagedFilenameFor(filename: string): string {
  return `${filename}${STAGED_SUFFIX}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const NON_RETRYABLE_NAMES = new Set(['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'AccessDenied'])
const RETRYABLE_4XX_NAMES = new Set(['RequestTimeout', 'SlowDown'])

/**
 * Story 9.6 D3.3/AC-13/AC-14: classifies an S3 upload error as retryable or not.
 * - Known non-retryable codes (credentials/permissions) fail fast — they will never succeed on
 *   retry (D3.13: `SignatureDoesNotMatch` stays non-retryable even though it can rarely be a
 *   transient clock-skew false positive — a documented, accepted trade-off, not a gap).
 * - Any other 4xx (except the two throttling/timeout codes below) is also treated as a permanent
 *   client-side error and fails fast.
 * - Everything else — recognized transient errors (5xx, `RequestTimeout`, `SlowDown`,
 *   connection-reset/timeout-shaped network errors) AND any unrecognized error shape — defaults
 *   to retryable (D3.12, adversarial review medium): retries are already bounded to 3 attempts,
 *   so a wrong "retry" guess costs at most ~2s of extra latency, while a wrong "fail fast" guess
 *   would silently convert a possibly-transient error into an immediate, unrecoverable failure.
 */
export function isRetryableS3Error(error: unknown): boolean {
  const name = (error as { name?: string })?.name
  if (name && NON_RETRYABLE_NAMES.has(name)) return false

  const httpStatus = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode
  if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500) {
    return Boolean(name && RETRYABLE_4XX_NAMES.has(name))
  }

  return true
}

// Maps a known error name/code to a short, sanitized phrase — never the raw SDK error message or
// stack, which could carry request/host details not appropriate for `backup_runs.errorMessage`
// (an operator-visible, potentially-shared field).
const CONNECTION_TIMED_OUT = 'connection timed out'

const ERROR_DESCRIPTIONS: Record<string, string> = {
  AccessDenied: 'access denied',
  InvalidAccessKeyId: 'invalid access key',
  SignatureDoesNotMatch: 'signature mismatch',
  SlowDown: 'throttled',
  RequestTimeout: CONNECTION_TIMED_OUT,
  ETIMEDOUT: CONNECTION_TIMED_OUT,
  TimeoutError: CONNECTION_TIMED_OUT,
  ECONNRESET: 'connection reset',
}

function describeS3Error(error: unknown): string {
  const name = (error as { name?: string })?.name ?? (error as { code?: string })?.code
  return (name && ERROR_DESCRIPTIONS[name]) || 'upload error'
}

type MinimalS3Client = Pick<S3Client, 'send'>

/**
 * Story 9.6 D3: local staging + bounded retry for the S3 destination. Stages the already-encrypted
 * `data` atomically (AC-12), uploads with up to 3 attempts total / exponential backoff (AC-13),
 * classifying failures as retryable or not (AC-14), deletes the staged file on success (AC-12) and
 * retains it on final failure for manual recovery (AC-15). Every thrown error carries a sanitized
 * message only — never a raw path or SDK error payload.
 */
export async function stageAndUploadToS3(params: {
  client: MinimalS3Client
  bucket: string
  filename: string
  data: Buffer
  /** Test-only override — production always uses `resolveStagingPath()`. */
  stagingPath?: string
}): Promise<void> {
  const stagingPath = params.stagingPath ?? resolveStagingPath()
  const stagedFilename = stagedFilenameFor(params.filename)
  const finalStagedPath = join(stagingPath, stagedFilename)

  // D3.8 (adversarial review, high): staging-directory creation failure is a new failure mode
  // introduced by staging-before-upload — routed through the same sanitized-failure path as any
  // other staging/upload error, never an unhandled exception, and the path itself is never
  // included in the message (it could reveal sensitive mount/filesystem layout).
  try {
    await atomicFileWrite(stagingPath, stagedFilename, params.data)
  } catch {
    throw new Error('S3 upload failed: could not create staging directory')
  }

  let lastError: unknown
  let attempts = 0
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    attempts = attempt
    try {
      await params.client.send(
        new PutObjectCommand({ Bucket: params.bucket, Key: params.filename, Body: params.data })
      )
      lastError = undefined
      break
    } catch (error) {
      lastError = error
      if (attempt === MAX_ATTEMPTS || !isRetryableS3Error(error)) break
      const backoff = BACKOFF_MS[attempt - 1]
      if (backoff !== undefined) {
        await sleep(backoff)
      }
    }
  }

  if (lastError) {
    // AC-15: retries exhausted or a non-retryable error hit immediately — leave the staged file
    // in place for operator recovery. Do NOT delete it.
    const reason = describeS3Error(lastError)
    const message =
      attempts > 1
        ? `S3 upload failed after ${attempts} attempts: ${reason}`
        : `S3 upload failed: ${reason}`
    throw new Error(message)
  }

  // AC-12: success (first attempt or after retry) — delete the staged file, no orphan left.
  await deleteStagedFileBestEffort(finalStagedPath)
}

/**
 * Code review fix (this story, high): the S3 upload has ALREADY succeeded by the time this is
 * called (the backup is durably stored), so a failure to delete the local staging leftover (e.g.
 * EACCES, a concurrent orphan-cleanup tick racing this exact delete) must never be reported as an
 * upload failure. An unguarded throw here would incorrectly flip `backup_runs.status` to `'failed'`
 * and fire the `backup.failure` alert for a backup that is genuinely safe in S3 — the orphaned
 * `.staged` file left behind by a failed delete is still swept by the 24h orphan-cleanup scan
 * (D3.6) either way, so nothing is silently lost by not retrying the delete here. Split into its
 * own function (rather than an inline try/catch) purely to keep `stageAndUploadToS3`'s cyclomatic
 * complexity within this repo's eslint threshold.
 */
async function deleteStagedFileBestEffort(finalStagedPath: string): Promise<void> {
  try {
    await rm(finalStagedPath, { force: true })
  } catch {
    // Swallowed deliberately — see doc comment above. Nothing actionable to surface: the
    // orphan-cleanup scan (D3.6/AC-16) will pick this file up within 24h regardless of why this
    // delete failed.
  }
}

/**
 * Story 9.6 D3.6/AC-16: hourly sweep — deletes `.staged` files older than 24h; a younger file, or
 * any file whose name doesn't end in the literal `.staged` suffix, is left untouched. A no-op
 * (0 deleted) if the staging directory doesn't exist at all (AC-16 edge: filesystem-destination
 * deployments, or an S3 deployment that has never had a failure — must not throw or create it).
 */
export async function cleanupOrphanedStagedFiles(
  stagingPath: string
): Promise<{ deleted: number }> {
  let entries: string[]
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- stagingPath is operator-configured (BACKUP_S3_STAGING_PATH) or its os.tmpdir()-based default, never user input.
    entries = await readdir(stagingPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { deleted: 0 }
    throw error
  }

  let deleted = 0
  const now = Date.now()
  for (const entry of entries) {
    if (!entry.endsWith(STAGED_SUFFIX)) continue
    const entryPath = join(stagingPath, entry)
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- entryPath is derived from a readdir() listing of the operator-configured staging path, never user input.
      const stats = await stat(entryPath)
      if (now - stats.mtimeMs <= ORPHAN_MAX_AGE_MS) continue
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- see comment above.
      await unlink(entryPath)
      deleted += 1
    } catch (error) {
      // D3.10 (adversarial review, medium): two overlapping hourly ticks racing to delete the
      // same aged file — the second unlink's ENOENT is expected, not an error; any other error
      // (permission, I/O) is still surfaced.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
  }
  return { deleted }
}

/**
 * Story 9.6 D3.9/AC-16b: cumulative bytes + file count across all `.staged` files currently in the
 * staging directory — feeds the `backup.staging_disk_pressure` monitoring alert. A no-op (0/0) if
 * the staging directory doesn't exist.
 */
export async function stagingDirectoryUsage(
  stagingPath: string
): Promise<{ totalBytes: number; fileCount: number }> {
  let entries: string[]
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- see cleanupOrphanedStagedFiles() comment above.
    entries = await readdir(stagingPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { totalBytes: 0, fileCount: 0 }
    throw error
  }

  let totalBytes = 0
  let fileCount = 0
  for (const entry of entries) {
    if (!entry.endsWith(STAGED_SUFFIX)) continue
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- see cleanupOrphanedStagedFiles() comment above.
      const stats = await stat(join(stagingPath, entry))
      totalBytes += stats.size
      fileCount += 1
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
  }
  return { totalBytes, fileCount }
}
