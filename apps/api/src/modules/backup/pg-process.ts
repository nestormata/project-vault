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

/** Mutable double-settlement guard shared across every listener that can settle one spawned
 * child's Promise (child 'error'/'close', and each stream's independent 'error') — see the
 * Story 28.8/28.11 comments on `runPgRestore`/`runPgDump` for why a stream's 'error' event needs
 * its own listener instead of being covered by `child.on('error', ...)`. */
type SettleGuard = { settled: boolean }

function guardedReject(
  guard: SettleGuard,
  reject: (err: PgProcessError) => void,
  message: string
): void {
  if (guard.settled) return
  guard.settled = true
  reject(new PgProcessError(message, ''))
}

/** Attaches an 'error' listener to a spawned child's stdout/stderr/stdin stream — each is an
 * independent EventEmitter from the `child` process object, so an error on the stream itself
 * (e.g. EPIPE, or the child being killed out-of-band mid-read/write) is delivered ON THE STREAM,
 * not on `child`, and would otherwise throw unhandled and crash the whole process. */
function attachStreamErrorReject(
  stream: NodeJS.EventEmitter,
  guard: SettleGuard,
  reject: (err: PgProcessError) => void,
  label: string
): void {
  stream.on('error', (err: Error) => guardedReject(guard, reject, `${label}: ${err.message}`))
}

/** Attaches the shared `child.on('close', ...)` settlement handler both `runPgDump` and
 * `runPgRestore` use: reject with a PgProcessError on a non-zero exit code, otherwise call
 * `onSuccess` (each function resolves its own Promise value differently). */
function attachCloseHandler(
  child: NodeJS.EventEmitter,
  guard: SettleGuard,
  reject: (err: PgProcessError) => void,
  onSuccess: () => void,
  exitedMessagePrefix: string,
  stderrChunks: Buffer[]
): void {
  child.on('close', (code: number | null) => {
    if (guard.settled) return
    guard.settled = true
    if (code !== 0) {
      reject(
        new PgProcessError(
          `${exitedMessagePrefix} exited with code ${code}`,
          tailBuffer(stderrChunks, MAX_STDERR_TAIL_BYTES)
        )
      )
      return
    }
    onSuccess()
  })
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
    // Story 28.11: `runPgDump` never needed a settlement guard before — its two previous
    // settlement points (child 'error', child 'close') were mutually exclusive by construction —
    // but the two new stream-level 'error' sources below break that, exactly like Story 28.8's
    // guard in runPgRestore.
    const guard: SettleGuard = { settled: false }
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
    attachStreamErrorReject(child.stdout, guard, reject, 'pg_dump: stdout read failed')
    attachStreamErrorReject(child.stderr, guard, reject, 'pg_dump: stderr read failed')
    child.on('error', (err) => guardedReject(guard, reject, `pg_dump: ${err.message}`))
    attachCloseHandler(
      child,
      guard,
      reject,
      () => resolve(Buffer.concat(stdoutChunks)),
      'pg_dump',
      stderrChunks
    )
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
    // Story 28.8: guards against double-settlement (AC6) when the stdin 'error' below races with
    // the child's own 'close'/'error' events (and, per Story 28.11, the new stdout/stderr stream
    // 'error' listeners) for the same failed restore attempt — Promise resolve/reject is a silent
    // no-op after the first settlement anyway, but this guard makes that explicit rather than
    // relying on it by accident, and prevents duplicate side effects (logging, etc.).
    const guard: SettleGuard = { settled: false }
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
    // Story 28.11: `runPgRestore` never reads `psql`'s stdout (see Dev Notes' scope note), so no
    // '.on(\'data\', ...)' is added here, only the 'error' listener needed to close the crash hazard.
    attachStreamErrorReject(child.stdout, guard, reject, 'psql restore: stdout read failed')
    attachStreamErrorReject(child.stderr, guard, reject, 'psql restore: stderr read failed')
    child.on('error', (err) => guardedReject(guard, reject, `psql restore: ${err.message}`))
    attachCloseHandler(child, guard, reject, resolve, 'psql restore', stderrChunks)
    // Story 28.8: `child.stdin` is itself a Writable stream — an independent EventEmitter from
    // the `child` process object above. If `psql` exits early (auth failure, unreachable host,
    // etc.) before consuming all of stdin, the OS closes the pipe and the write below fails with
    // EPIPE, delivered as an 'error' event ON THE STDIN STREAM, not on `child`. Without a listener
    // here, Node treats that as unhandled and throws it synchronously, crashing the whole process
    // — this listener must be attached BEFORE `.end(sql)` is called so it's guaranteed to catch
    // an error that could in principle fire on the same tick.
    attachStreamErrorReject(child.stdin, guard, reject, 'psql restore: stdin write failed')
    child.stdin.end(sql)
  })
}
