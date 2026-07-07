// Story 8-6 AC-6 — worker process spawned by cache-store-concurrency.test.ts. Runs in a genuinely
// separate OS process (via `node`, not a worker_thread sharing the parent's event loop) so the
// concurrent file writes below exercise the real cross-process race the retro flagged: multiple CI
// processes on the same host calling the real `readCacheFile()`/`writeCacheFile()` against the same
// shared cache file. Deliberately imports the real production module, not a reimplementation.
import { buildCacheEntry, readCacheFile, withEntry, writeCacheFile } from '../cache-store.js'

function requireArg(value: string | undefined, label: string): string {
  if (!value) {
    process.stderr.write(`[cache-concurrency-worker] missing required arg: ${label}\n`)
    process.exit(1)
  }
  return value
}

const [, , pathArg, workerIdArg, iterationsArg] = process.argv
const path = requireArg(pathArg, 'path')
const workerId = Number(requireArg(workerIdArg, 'workerId'))
const iterations = Number(requireArg(iterationsArg, 'iterations'))

function run(): void {
  for (let i = 0; i < iterations; i += 1) {
    // Genuine read-modify-write cycle against the shared file, same as a real getSecret() caller.
    const cache = readCacheFile(path)
    const entry = buildCacheEntry(
      { version: 1, iv: 'aa', ciphertext: `worker${workerId}-iter${i}`, tag: 'cc' },
      i + 1
    )
    writeCacheFile(path, withEntry(cache, `WORKER_${workerId}_KEY_${i}`, entry))
  }
}

try {
  run()
  process.exit(0)
} catch (error) {
  process.stderr.write(
    `[cache-concurrency-worker ${workerId}] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
  )
  process.exit(1)
}
