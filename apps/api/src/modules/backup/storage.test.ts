/* eslint-disable security/detect-non-literal-fs-filename -- test exercises dynamic temp-dir paths */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { backupStorageFor, BackupNotFoundOnDestinationError } from './storage.js'

const TEST_FILENAME = 'backup_test.vault'
const TMP_PREFIX = 'backup-storage-test-'
function newTempDir(): string {
  return mkdtempSync(join(tmpdir(), TMP_PREFIX))
}
function storageFor(path: string) {
  return backupStorageFor({ type: 'filesystem', path })
}

describe('Story 9.1 AC-5: filesystem backup storage', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('writes then reads back the exact bytes', async () => {
    dir = newTempDir()
    const storage = storageFor(dir)
    const data = Buffer.from('encrypted backup bytes')

    await storage.write(TEST_FILENAME, data)
    const read = await storage.read(TEST_FILENAME)

    expect(read.equals(data)).toBe(true)
  })

  it('never leaves a partially written file under its final name (atomic tmp+rename)', async () => {
    dir = newTempDir()
    const storage = storageFor(dir)
    await storage.write('backup_atomic.vault', Buffer.from('final content'))

    const entries = readdirSync(dir)
    expect(entries).toEqual(['backup_atomic.vault'])
    expect(entries.some((e) => e.startsWith('.tmp-'))).toBe(false)
  })

  it('throws BackupNotFoundOnDestinationError for a missing filename', async () => {
    dir = newTempDir()
    const storage = storageFor(dir)

    await expect(storage.read('nonexistent.vault')).rejects.toBeInstanceOf(
      BackupNotFoundOnDestinationError
    )
  })

  it('creates the destination directory if it does not exist yet', async () => {
    dir = join(newTempDir(), 'nested', 'path')
    const storage = storageFor(dir)

    await storage.write('backup_nested.vault', Buffer.from('x'))

    expect(readdirSync(dir)).toContain('backup_nested.vault')
  })

  it('delete removes the file and is a no-op if already absent', async () => {
    const filename = 'backup_delete_me.vault'
    dir = newTempDir()
    const storage = storageFor(dir)
    await storage.write(filename, Buffer.from('x'))

    await storage.delete(filename)
    expect(readdirSync(dir)).not.toContain(filename)

    // No throw on a second delete of an already-absent file.
    await expect(storage.delete(filename)).resolves.toBeUndefined()
  })
})

describe('Story 9.1 AC-6 negative: S3 destination upload failure', () => {
  it('write() rejects when the configured endpoint is unreachable (auth/network failure)', async () => {
    // Nothing listens on port 1 — this fails fast (ECONNREFUSED) rather than timing out, giving
    // executeBackupSnapshot's caller (backup-snapshot worker) a real, non-mocked rejection to
    // catch and translate into backup_runs.status = 'failed' (AC-6's negative example).
    const storage = backupStorageFor({
      type: 's3',
      bucket: 'unreachable-test-bucket',
      endpoint: 'http://127.0.0.1:1',
      region: 'us-east-1',
    })

    await expect(storage.write(TEST_FILENAME, Buffer.from('x'))).rejects.toBeTruthy()
  })
})
