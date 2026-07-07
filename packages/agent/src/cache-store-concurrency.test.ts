import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getEntry, readCacheFile } from './cache-store.js'
import { VaultCacheCorruptedError } from './errors.js'

// Story 8-6 AC-6 — 7.2's adversarial review (high) flagged that the shared agent cache file has no
// documented protection against multiple concurrent CI processes on the same host writing to it
// simultaneously, and the story's own Completion Notes admitted a true multi-process race test was
// never run "given time constraints." This spawns genuinely separate OS processes (not
// worker_threads, not Promise.all within one process) against the same cache file, each calling
// the real writeCacheFile()/readCacheFile() path, and asserts the atomic-rename write pattern
// actually holds up under real concurrent load: no crash, no VaultCacheCorruptedError.

const __dirname = dirname(fileURLToPath(import.meta.url))
const WORKER_SCRIPT = join(__dirname, '__fixtures__', 'cache-concurrency-worker.ts')
const TSX_BIN = join(__dirname, '..', '..', '..', 'node_modules', '.bin', 'tsx')
const WORKER_COUNT = 8
const ITERATIONS_PER_WORKER = 15

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vault-agent-cache-concurrency-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('cache-store concurrent multi-process writes (AC-6)', () => {
  it('confirms the test harness (tsx binary) is available', () => {
    expect(existsSync(TSX_BIN)).toBe(true)
    expect(existsSync(WORKER_SCRIPT)).toBe(true)
  })

  it('survives N concurrent OS processes writing to the same cache file with no crash and no corruption', async () => {
    const path = join(dir, 'cache.json')

    const results = await Promise.allSettled(
      Array.from({ length: WORKER_COUNT }, (_, workerId) =>
        runWorker(path, workerId, ITERATIONS_PER_WORKER)
      )
    )

    // No crash: every spawned process exits 0. A non-zero exit (or a thrown/rejected promise
    // here) means writeCacheFile()/readCacheFile() threw inside the worker.
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    if (failures.length > 0) {
      throw new Error(
        `${failures.length}/${WORKER_COUNT} worker process(es) failed:\n` +
          failures.map((f) => String(f.reason)).join('\n')
      )
    }

    // No corruption: the final file must still parse as a well-formed cache file. A torn write
    // from the old shared-tmp-file race would surface here as VaultCacheCorruptedError.
    let finalCache: ReturnType<typeof readCacheFile>
    expect(() => {
      finalCache = readCacheFile(path)
    }).not.toThrow(VaultCacheCorruptedError)
    finalCache = readCacheFile(path)

    // At least some writes landed — the file isn't just the initial empty `{}` (which would mean
    // every single write silently no-op'd rather than actually racing).
    const keys = Object.keys(finalCache)
    expect(keys.length).toBeGreaterThan(0)

    // Atomicity check: `writeCacheFile` always writes the *entire* map to a uniquely-named temp
    // file, then renames it whole over the real path — so under true concurrent load, the file on
    // disk at any instant must be exactly ONE writer's complete, self-consistent snapshot, never a
    // byte-level splice of two different writers' output (that's what a non-atomic write pattern
    // would produce). This is asserted here, not just claimed in a comment: every surviving
    // entry's `versionNumber`/`ciphertext` must exactly match what its own key's writer/iteration
    // encoded, proving no cross-write mixing at the entry level. Some entries are legitimately
    // absent (an expected, accepted lost-update outcome of last-snapshot-wins with no per-key
    // merge or lock — not a correctness bug per AC-6's Dev Notes), but none may be corrupted.
    for (const key of keys) {
      const match = /^WORKER_(\d+)_KEY_(\d+)$/.exec(key)
      expect(match).not.toBeNull()
      const [, workerIdStr, iterStr] = match as RegExpExecArray
      const entry = getEntry(finalCache, key)
      expect(entry).toBeDefined()
      expect(entry?.versionNumber).toBe(Number(iterStr) + 1)
      expect(entry?.encryptedValue.ciphertext).toBe(`worker${workerIdStr}-iter${iterStr}`)
    }
  }, 30_000)
})

// `spawn` (not `execFileSync`) is essential here: it launches the child asynchronously without
// blocking the parent event loop, so calling this WORKER_COUNT times back-to-back below actually
// starts all processes running concurrently rather than serializing them one at a time.
function runWorker(path: string, workerId: number, iterations: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX_BIN, [WORKER_SCRIPT, path, String(workerId), String(iterations)], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`worker ${workerId} exited with code ${code}\n${stderr}`))
      }
    })
  })
}
