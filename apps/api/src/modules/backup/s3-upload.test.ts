/* eslint-disable security/detect-non-literal-fs-filename -- test exercises dynamic temp-dir paths */
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

process.env['BACKUP_S3_STAGING_PATH'] ??= ''

const {
  cleanupOrphanedStagedFiles,
  isRetryableS3Error,
  resolveStagingPath,
  stagedFilenameFor,
  stageAndUploadToS3,
  stagingDirectoryUsage,
} = await import('./s3-upload.js')

const BUCKET = 'vault-backups-test'
const FILENAME = 'backup_20260101T000000000Z_test.vault'
const TMP_PREFIX = 's3-upload-test-'

function fakeClient(sendImpl: (command: unknown) => Promise<unknown>) {
  return { send: vi.fn(sendImpl) }
}

describe('Story 9.6 D3: s3-upload staging path resolution', () => {
  it('resolveStagingPath falls back to os.tmpdir()-based default when BACKUP_S3_STAGING_PATH is unset', () => {
    const original = process.env['BACKUP_S3_STAGING_PATH']
    delete process.env['BACKUP_S3_STAGING_PATH']
    expect(resolveStagingPath()).toContain('vault-backup-staging')
    if (original !== undefined) process.env['BACKUP_S3_STAGING_PATH'] = original
  })

  it('stagedFilenameFor appends the exact .staged suffix', () => {
    expect(stagedFilenameFor('backup_x.vault')).toBe('backup_x.vault.staged')
  })
})

describe('Story 9.6 AC-12/AC-13/AC-14/AC-15: stageAndUploadToS3', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('AC-12: stages the encrypted bytes atomically, uploads, then deletes the staged file on success — no orphan', async () => {
    dir = mkdtempSync(join(tmpdir(), TMP_PREFIX))
    const data = Buffer.from('encrypted-ciphertext')
    let uploadedBody: Buffer | undefined
    const client = fakeClient(async (command) => {
      const input = (command as { input: { Body: Buffer } }).input
      uploadedBody = input.Body
      return {}
    })

    await stageAndUploadToS3({ client, bucket: BUCKET, filename: FILENAME, data, stagingPath: dir })

    expect(uploadedBody?.equals(data)).toBe(true)
    expect(readdirSync(dir)).toEqual([])
  })

  it('AC-13: retries a transient failure and succeeds on the second attempt', async () => {
    dir = mkdtempSync(join(tmpdir(), TMP_PREFIX))
    const data = Buffer.from('data')
    let attempts = 0
    const client = fakeClient(async () => {
      attempts += 1
      if (attempts === 1) {
        const err = new Error('connection reset') as Error & { name: string }
        err.name = 'ECONNRESET'
        throw err
      }
      return {}
    })

    await stageAndUploadToS3({ client, bucket: BUCKET, filename: FILENAME, data, stagingPath: dir })
    expect(attempts).toBe(2)
    expect(readdirSync(dir)).toEqual([])
  })

  it('AC-14: fails fast (single attempt) on a non-retryable AccessDenied error', async () => {
    dir = mkdtempSync(join(tmpdir(), TMP_PREFIX))
    const data = Buffer.from('data')
    let attempts = 0
    const client = fakeClient(async () => {
      attempts += 1
      const err = new Error('access denied') as Error & { name: string }
      err.name = 'AccessDenied'
      throw err
    })

    await expect(
      stageAndUploadToS3({ client, bucket: BUCKET, filename: FILENAME, data, stagingPath: dir })
    ).rejects.toThrow(/access denied/)
    expect(attempts).toBe(1)
    // AC-15: staged file retained on final failure — recoverable.
    expect(readdirSync(dir)).toEqual([stagedFilenameFor(FILENAME)])
  })

  it('AC-14 edge (D3.12): an unrecognized error code defaults to retryable, not fail-fast', async () => {
    dir = mkdtempSync(join(tmpdir(), TMP_PREFIX))
    const data = Buffer.from('data')
    let attempts = 0
    const client = fakeClient(async () => {
      attempts += 1
      const err = new Error('mystery network error') as Error & { name: string }
      err.name = 'NetworkingError'
      if (attempts < 2) throw err
      return {}
    })

    await stageAndUploadToS3({ client, bucket: BUCKET, filename: FILENAME, data, stagingPath: dir })
    expect(attempts).toBe(2)
  }, 10_000)

  it('AC-15: all 3 attempts fail (transient) — staged file retained, sanitized error message includes attempt count', async () => {
    dir = mkdtempSync(join(tmpdir(), TMP_PREFIX))
    const data = Buffer.from('data')
    let attempts = 0
    const client = fakeClient(async () => {
      attempts += 1
      const err = new Error('timed out') as Error & { name: string }
      err.name = 'RequestTimeout'
      throw err
    })

    await expect(
      stageAndUploadToS3({ client, bucket: BUCKET, filename: FILENAME, data, stagingPath: dir })
    ).rejects.toThrow(/S3 upload failed after 3 attempts/)
    expect(attempts).toBe(3)
    expect(readdirSync(dir)).toEqual([stagedFilenameFor(FILENAME)])
  }, 10_000)

  it('AC-12 edge: the staged ciphertext on disk is byte-identical to what is uploaded (never plaintext, never a second differently-encrypted copy)', async () => {
    dir = mkdtempSync(join(tmpdir(), TMP_PREFIX))
    const data = Buffer.from('ciphertext-bytes-xyz')
    let uploadedBody: Buffer | undefined
    let stagedAtUploadTime: Buffer | undefined
    const client = fakeClient(async (command) => {
      // Read the staged file mid-upload, before the post-success delete runs.
      stagedAtUploadTime = readFileSync(join(dir, stagedFilenameFor(FILENAME)))
      uploadedBody = (command as { input: { Body: Buffer } }).input.Body
      return {}
    })

    await stageAndUploadToS3({ client, bucket: BUCKET, filename: FILENAME, data, stagingPath: dir })

    expect(stagedAtUploadTime?.equals(data)).toBe(true)
    expect(uploadedBody?.equals(data)).toBe(true)
  })

  it('D3.8: staging directory creation failure fails cleanly with a sanitized message (path never logged verbatim)', async () => {
    // Point the staging path at a path nested under a file (not a directory) — mkdir(recursive)
    // will fail with ENOTDIR.
    dir = mkdtempSync(join(tmpdir(), TMP_PREFIX))
    const blockerFile = join(dir, 'blocker')
    writeFileSync(blockerFile, 'x')
    const badStagingPath = join(blockerFile, 'staging')
    const client = fakeClient(async () => ({}))

    await expect(
      stageAndUploadToS3({
        client,
        bucket: BUCKET,
        filename: FILENAME,
        data: Buffer.from('x'),
        stagingPath: badStagingPath,
      })
    ).rejects.toThrow('S3 upload failed: could not create staging directory')
  })
})

describe('Story 9.6: isRetryableS3Error classification', () => {
  it('classifies known non-retryable codes as non-retryable', () => {
    for (const name of ['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'AccessDenied']) {
      expect(isRetryableS3Error({ name })).toBe(false)
    }
  })

  it('classifies known transient/throttling codes as retryable', () => {
    for (const name of ['RequestTimeout', 'SlowDown']) {
      expect(isRetryableS3Error({ name })).toBe(true)
    }
  })

  it('D3.12: defaults an unrecognized error to retryable', () => {
    expect(isRetryableS3Error({ name: 'SomeTotallyUnknownError' })).toBe(true)
    expect(isRetryableS3Error(new Error('generic'))).toBe(true)
  })

  it('D3.13: SignatureDoesNotMatch (possible clock-skew false positive) is still classified non-retryable, a documented trade-off', () => {
    expect(isRetryableS3Error({ name: 'SignatureDoesNotMatch' })).toBe(false)
  })

  it('Story 10.4 branch coverage: an unrecognized 4xx (client error) fails fast, not retryable', () => {
    expect(isRetryableS3Error({ name: 'SomeOther4xx', $metadata: { httpStatusCode: 403 } })).toBe(
      false
    )
    expect(isRetryableS3Error({ $metadata: { httpStatusCode: 400 } })).toBe(false)
  })

  it('Story 10.4 branch coverage: a 4xx whose name IS in the throttling/timeout allowlist stays retryable', () => {
    expect(isRetryableS3Error({ name: 'SlowDown', $metadata: { httpStatusCode: 429 } })).toBe(true)
  })

  it('Story 10.4 branch coverage: a 5xx (server error) with httpStatusCode metadata is retryable', () => {
    expect(isRetryableS3Error({ name: 'InternalError', $metadata: { httpStatusCode: 500 } })).toBe(
      true
    )
  })
})

describe('Story 9.6 AC-16: cleanupOrphanedStagedFiles', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('deletes .staged files older than 24h, leaves younger ones and non-.staged files untouched', async () => {
    dir = mkdtempSync(join(tmpdir(), 's3-upload-cleanup-test-'))
    const oldFile = join(dir, 'backup_old.vault.staged')
    const newFile = join(dir, 'backup_new.vault.staged')
    const unrelatedFile = join(dir, 'notes.txt')
    writeFileSync(oldFile, 'old')
    writeFileSync(newFile, 'new')
    writeFileSync(unrelatedFile, 'unrelated')

    const oldTime = (Date.now() - 30 * 60 * 60 * 1000) / 1000
    utimesSync(oldFile, oldTime, oldTime)
    const oldUnrelatedTime = oldTime
    utimesSync(unrelatedFile, oldUnrelatedTime, oldUnrelatedTime)

    const result = await cleanupOrphanedStagedFiles(dir)

    expect(result.deleted).toBe(1)
    const remaining = readdirSync(dir).sort()
    expect(remaining).toEqual(['backup_new.vault.staged', 'notes.txt'].sort())
  })

  it('is a no-op (returns 0, does not throw) when the staging directory does not exist', async () => {
    const result = await cleanupOrphanedStagedFiles(join(tmpdir(), `nonexistent-${Date.now()}`))
    expect(result.deleted).toBe(0)
  })

  it('D3.10: an already-deleted file (concurrent tick) is ignored (ENOENT), not thrown', async () => {
    dir = mkdtempSync(join(tmpdir(), 's3-upload-cleanup-test-'))
    const oldFile = join(dir, 'backup_race.vault.staged')
    writeFileSync(oldFile, 'old')
    const oldTime = (Date.now() - 30 * 60 * 60 * 1000) / 1000
    utimesSync(oldFile, oldTime, oldTime)

    // Simulate two overlapping ticks racing to delete the same file: run cleanup twice
    // concurrently — neither call should throw.
    await expect(
      Promise.all([cleanupOrphanedStagedFiles(dir), cleanupOrphanedStagedFiles(dir)])
    ).resolves.toBeDefined()
  })
})

describe('Story 9.6 AC-16b: stagingDirectoryUsage', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('sums total bytes and file count across all .staged files, ignoring non-.staged files', async () => {
    dir = mkdtempSync(join(tmpdir(), 's3-upload-usage-test-'))
    writeFileSync(join(dir, 'a.vault.staged'), Buffer.alloc(100))
    writeFileSync(join(dir, 'b.vault.staged'), Buffer.alloc(200))
    writeFileSync(join(dir, 'notes.txt'), Buffer.alloc(9999))

    const usage = await stagingDirectoryUsage(dir)
    expect(usage.totalBytes).toBe(300)
    expect(usage.fileCount).toBe(2)
  })

  it('is a no-op (0/0) when the staging directory does not exist', async () => {
    const usage = await stagingDirectoryUsage(join(tmpdir(), `nonexistent-${Date.now()}`))
    expect(usage).toEqual({ totalBytes: 0, fileCount: 0 })
  })
})
