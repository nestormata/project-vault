import { parentPort, workerData } from 'node:worker_threads'
import { encryptBackupBuffer, decryptBackupBuffer, BackupDecryptError } from './backup-crypto.js'

type WorkerAction = 'encrypt' | 'decrypt'
type WorkerInput = { action: WorkerAction; data: Buffer; key: Buffer }
type WorkerResult =
  | { ok: true; result: Buffer }
  // `kind` lets the caller (run-backup-worker.ts) reconstruct the correct Error subclass —
  // structured-clone across the worker_thread boundary otherwise loses the original error's
  // class identity, which callers rely on (`error instanceof BackupDecryptError`) to distinguish
  // "wrong key / corrupted ciphertext" from any other failure (AC-9's 401 backup_decrypt_failed).
  | { ok: false; message: string; kind: 'decrypt_failed' | 'other' }

/**
 * Story 9.1 D5/AC-5: worker_threads entry point for CPU-bound AES-256-GCM backup
 * encryption/decryption — architecture.md's explicit mandate for CPU-bound crypto handlers, and
 * the first story to actually implement that pattern (see packages/crypto/src/workers/README
 * intent in architecture.md's structure listing). One worker per task (not a long-lived pool) —
 * simple and sufficient for the low frequency of backup/restore/validate operations.
 */
function run(): void {
  const { action, data, key } = workerData as WorkerInput
  let message: WorkerResult
  try {
    // workerData survives structured-clone as a Uint8Array, not necessarily a Node `Buffer`
    // instance — re-wrap so `.subarray()`/`.equals()` (Buffer-specific) work correctly inside
    // encryptBackupBuffer/decryptBackupBuffer.
    const dataBuffer = Buffer.from(data)
    const keyBuffer = Buffer.from(key)
    const result =
      action === 'encrypt'
        ? encryptBackupBuffer(dataBuffer, keyBuffer)
        : decryptBackupBuffer(dataBuffer, keyBuffer)
    message = { ok: true, result }
  } catch (error) {
    message = {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
      kind: error instanceof BackupDecryptError ? 'decrypt_failed' : 'other',
    }
  }
  parentPort?.postMessage(message)
}

run()
