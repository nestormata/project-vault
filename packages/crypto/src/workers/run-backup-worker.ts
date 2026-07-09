import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { encryptBackupBuffer, decryptBackupBuffer, BackupDecryptError } from './backup-crypto.js'

type WorkerAction = 'encrypt' | 'decrypt'
type WorkerResult =
  { ok: true; result: Buffer } | { ok: false; message: string; kind: 'decrypt_failed' | 'other' }

// Resolved relative to THIS module's own runtime location — in production this module runs from
// packages/crypto/dist/workers/run-backup-worker.js, so the sibling compiled
// backup-encrypt.worker.js always exists there.
const WORKER_URL = new URL('./backup-encrypt.worker.js', import.meta.url)

function runViaWorkerThread(action: WorkerAction, data: Buffer, key: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, { workerData: { action, data, key } })
    worker.once('message', (message: WorkerResult) => {
      worker.terminate()
      if (message.ok) {
        resolve(Buffer.from(message.result))
        return
      }
      // Reconstruct the original error class — structured-clone across the worker_thread
      // boundary loses it otherwise, and callers rely on `instanceof BackupDecryptError` (AC-9's
      // 401 backup_decrypt_failed vs. any other failure).
      reject(
        message.kind === 'decrypt_failed'
          ? new BackupDecryptError(message.message)
          : new Error(message.message)
      )
    })
    worker.once('error', (err) => {
      worker.terminate()
      reject(err)
    })
  })
}

/**
 * Story 9.1 D5/AC-5: offloads CPU-bound AES-256-GCM backup encryption/decryption to a
 * `worker_thread` (architecture.md's mandate for CPU-bound crypto handlers — "backup encryption,
 * audit log hash chain verification... run via worker_threads"). This is the first story to
 * actually implement that pattern (no prior story had CPU-bound crypto workers).
 *
 * Falls back to running the identical pure function synchronously on the calling thread only
 * when the compiled worker artifact (`backup-encrypt.worker.js`) is not present on disk — e.g. a
 * test runner that transpiles this package's TypeScript in-memory from `src/` rather than from a
 * built `dist/`. Production always runs from `dist/` (see apps/api/Dockerfile's build stage), so
 * the real worker_thread path is always exercised there; this fallback exists purely so the
 * business logic (encrypt/decrypt correctness) is testable without also requiring every test
 * runner to have a pre-built `packages/crypto/dist` on disk.
 */
export async function runBackupCrypto(
  action: WorkerAction,
  data: Buffer,
  key: Buffer
): Promise<Buffer> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- WORKER_URL is a fixed, module-relative sibling-file path (not user input).
  if (existsSync(fileURLToPath(WORKER_URL))) {
    return runViaWorkerThread(action, data, key)
  }
  return action === 'encrypt' ? encryptBackupBuffer(data, key) : decryptBackupBuffer(data, key)
}
