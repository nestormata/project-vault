import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runBackupCrypto } from './run-backup-worker.js'

const KEY = randomBytes(32)
const __dirname = dirname(fileURLToPath(import.meta.url))
const DIST_ENTRY = resolve(__dirname, '../../dist/workers/run-backup-worker.js')

describe('Story 9.1 D5/AC-5: runBackupCrypto (worker_thread offload with sync fallback)', () => {
  it('round-trips via the synchronous fallback when no compiled worker artifact is present', async () => {
    // Running against src/ (not a built dist/), so the sibling .worker.js referenced by
    // run-backup-worker.ts does not exist on disk — this deterministically exercises the
    // documented fallback path, proving the business logic works without requiring a real
    // worker_thread spin-up in every test environment.
    const plaintext = Buffer.from('pretend this is a gzipped pg_dump')
    const encrypted = await runBackupCrypto('encrypt', plaintext, KEY)
    const decrypted = await runBackupCrypto('decrypt', encrypted, KEY)
    expect(decrypted.equals(plaintext)).toBe(true)
  })

  it.runIf(existsSync(DIST_ENTRY))(
    'round-trips via the real worker_thread when the compiled dist artifact is present',
    async () => {
      const { runBackupCrypto: runBackupCryptoFromDist } = (await import(DIST_ENTRY)) as {
        runBackupCrypto: typeof runBackupCrypto
      }
      const plaintext = Buffer.from('pretend this is a gzipped pg_dump, via the real worker')
      const encrypted = await runBackupCryptoFromDist('encrypt', plaintext, KEY)
      const decrypted = await runBackupCryptoFromDist('decrypt', encrypted, KEY)
      expect(decrypted.equals(plaintext)).toBe(true)
    }
  )
})
