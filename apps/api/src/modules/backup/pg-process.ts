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
      'pg_dump',
      ['-h', conn.host, '-p', conn.port, '-U', conn.user, '-d', conn.database, '--format=plain'],
      { env: { ...process.env, PGPASSWORD: conn.password } }
    )
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
    child.on('error', (err) => reject(new PgProcessError(`pg_dump: ${err.message}`, '')))
    child.on('close', (code) => {
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
      'psql',
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
      ],
      { env: { ...process.env, PGPASSWORD: conn.password } }
    )
    const stderrChunks: Buffer[] = []
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
    child.on('error', (err) => reject(new PgProcessError(`psql restore: ${err.message}`, '')))
    child.on('close', (code) => {
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
    child.stdin.end(sql)
  })
}
