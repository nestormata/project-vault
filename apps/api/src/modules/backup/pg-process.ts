import { spawn } from 'node:child_process'

export class PgProcessError extends Error {
  constructor(
    message: string,
    public readonly stderrTail: string
  ) {
    super(message)
    this.name = 'PgProcessError'
  }
}

type ParsedConnection = {
  host: string
  port: string
  user: string
  password: string
  database: string
}

/** Parses a postgres connection string into discrete parts so the password can be passed via
 * the PGPASSWORD environment variable rather than a CLI argument — CLI args are visible to any
 * other local process via `ps`/`/proc`; env vars set only on this child process are not. */
function parseConnectionString(connectionString: string): ParsedConnection {
  const url = new URL(connectionString)
  return {
    host: url.hostname,
    port: url.port || '5432',
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
  }
}

const MAX_STDERR_TAIL_BYTES = 4096

function tailBuffer(chunks: Buffer[], maxBytes: number): string {
  const combined = Buffer.concat(chunks)
  return combined.subarray(Math.max(0, combined.length - maxBytes)).toString('utf8')
}

/**
 * Story 9.1 D4/AC-5: spawns `pg_dump` against `BACKUP_DATABASE_URL` (the RLS-bypassing
 * superuser/BYPASSRLS connection — never the API's own DATABASE_URL, which is RLS-restricted by
 * design and would silently produce an empty or single-org backup) and resolves with the full
 * plain-SQL dump as a Buffer. Collected in memory rather than streamed — acceptable for v1's
 * self-hosted scale; a future story could switch to a streaming pipeline for very large instances
 * without changing this function's external contract.
 */
export async function runPgDump(connectionString: string): Promise<Buffer> {
  const conn = parseConnectionString(connectionString)
  return new Promise((resolve, reject) => {
    const child = spawn(
      'pg_dump', // NOSONAR(typescript:S4036) — trusted binary on this container's fixed image PATH
      [
        '-h',
        conn.host,
        '-p',
        conn.port,
        '-U',
        conn.user,
        '-d',
        conn.database,
        '--format=plain',
        // Code review fix (AC-9 "all current data is replaced"): without --clean/--if-exists, a
        // plain-format dump contains only CREATE statements, never DROP — replaying it via
        // runPgRestore/psql against BACKUP_DATABASE_URL (which points at the SAME live database
        // DATABASE_URL serves, per D4) would fail immediately on the first `CREATE TABLE` with
        // "relation already exists" (psql runs with --set=ON_ERROR_STOP=1). --clean emits a DROP
        // (guarded by --if-exists so a partially-empty target doesn't itself error) before each
        // CREATE, which is what actually makes "replace all current data" true.
        '--clean',
        '--if-exists',
      ],
      { env: { ...process.env, PGPASSWORD: conn.password } }
    )
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    // Story 28.11: `settled` guards against double-settlement when a stdout/stderr stream
    // 'error' (new below) races with the child's own 'close'/'error' events for the same failed
    // dump attempt. `runPgDump` never needed this before — its two previous settlement points
    // (child 'error', child 'close') were mutually exclusive by construction — but the two new
    // stream-level sources below break that, exactly like Story 28.8's guard in runPgRestore.
    let settled = false
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
    // Story 28.11: `child.stdout`/`child.stderr` are themselves independent Readable-stream
    // EventEmitters from the `child` process object — a stream-level 'error' (e.g. the child
    // being killed out-of-band while data is still in-flight on the pipe) is delivered ON THE
    // STREAM, not on `child`, so `child.on('error', ...)` below does not cover it. Without a
    // listener here, Node treats that as unhandled and crashes the whole process — the same
    // hazard class Story 28.8 fixed for `runPgRestore`'s stdin.
    child.stdout.on('error', (err) => {
      if (settled) return
      settled = true
      reject(new PgProcessError(`pg_dump: stdout read failed: ${err.message}`, ''))
    })
    child.stderr.on('error', (err) => {
      if (settled) return
      settled = true
      reject(new PgProcessError(`pg_dump: stderr read failed: ${err.message}`, ''))
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      reject(new PgProcessError(`pg_dump: ${err.message}`, ''))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (code !== 0) {
        reject(
          new PgProcessError(
            `pg_dump exited with code ${code}`,
            tailBuffer(stderrChunks, MAX_STDERR_TAIL_BYTES)
          )
        )
        return
      }
      resolve(Buffer.concat(stdoutChunks))
    })
  })
}

/**
 * Story 9.1 D4/AC-9: restores a decrypted, decompressed plain-SQL dump against
 * `BACKUP_DATABASE_URL` via `psql` (plain-SQL format restores via `psql`, not `pg_restore`, which
 * is for custom/directory/tar formats only — this matches `runPgDump`'s `--format=plain`).
 */
export async function runPgRestore(connectionString: string, sql: Buffer): Promise<void> {
  const conn = parseConnectionString(connectionString)
  return new Promise((resolve, reject) => {
    const child = spawn(
      'psql', // NOSONAR(typescript:S4036) — trusted binary on this container's fixed image PATH
      [
        '-h',
        conn.host,
        '-p',
        conn.port,
        '-U',
        conn.user,
        '-d',
        conn.database,
        '--set=ON_ERROR_STOP=1',
        // Code review fix: wrap the whole restore in one transaction so a failure partway
        // through (e.g. a single bad statement) rolls back everything instead of leaving the
        // database in a half-restored, half-original state — a destructive operation that fails
        // must fail atomically, not partially.
        '--single-transaction',
      ],
      { env: { ...process.env, PGPASSWORD: conn.password } }
    )
    const stderrChunks: Buffer[] = []
    // Story 28.8: `settled` guards against double-settlement (AC6) when the stdin 'error' below
    // races with the child's own 'close'/'error' events for the same failed restore attempt —
    // Promise resolve/reject is a silent no-op after the first settlement anyway, but this guard
    // makes that explicit rather than relying on it by accident, and prevents duplicate side
    // effects if this function's shape ever grows any (logging, etc.).
    let settled = false
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
    // Story 28.11: `child.stdout`/`child.stderr` are themselves independent Readable-stream
    // EventEmitters from the `child` process object, exactly like `child.stdin` below — a
    // stream-level 'error' is delivered ON THE STREAM, not on `child`. `runPgRestore` never reads
    // `psql`'s stdout (see Dev Notes' scope note), so no '.on(\'data\', ...)' is added here, only
    // the 'error' listener needed to close the crash hazard.
    child.stdout.on('error', (err) => {
      if (settled) return
      settled = true
      reject(new PgProcessError(`psql restore: stdout read failed: ${err.message}`, ''))
    })
    child.stderr.on('error', (err) => {
      if (settled) return
      settled = true
      reject(new PgProcessError(`psql restore: stderr read failed: ${err.message}`, ''))
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      reject(new PgProcessError(`psql restore: ${err.message}`, ''))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (code !== 0) {
        reject(
          new PgProcessError(
            `psql restore exited with code ${code}`,
            tailBuffer(stderrChunks, MAX_STDERR_TAIL_BYTES)
          )
        )
        return
      }
      resolve()
    })
    // Story 28.8: `child.stdin` is itself a Writable stream — an independent EventEmitter from
    // the `child` process object above. If `psql` exits early (auth failure, unreachable host,
    // etc.) before consuming all of stdin, the OS closes the pipe and the write below fails with
    // EPIPE, delivered as an 'error' event ON THE STDIN STREAM, not on `child`. Without a listener
    // here, Node treats that as unhandled and throws it synchronously, crashing the whole process
    // — this listener must be attached BEFORE `.end(sql)` is called so it's guaranteed to catch
    // an error that could in principle fire on the same tick.
    child.stdin.on('error', (err) => {
      if (settled) return
      settled = true
      reject(new PgProcessError(`psql restore: stdin write failed: ${err.message}`, ''))
    })
    child.stdin.end(sql)
  })
}
