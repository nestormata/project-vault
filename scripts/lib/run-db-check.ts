import postgres from 'postgres'
import { pgTlsOptions } from '@project-vault/db/pg-tls'

/**
 * Shared CLI-script boilerplate for a one-shot DB integrity check (`check-rls-coverage.ts`,
 * `check-audit-actor-token-coverage.ts`, ...): reads `DATABASE_URL`, connects, runs `check`, and
 * writes `successMessage` to stdout on success. Any thrown error is handed to `onError` for
 * check-specific formatting, after which the process exits non-zero. The connection is always
 * closed, success or failure.
 *
 * Returns `void` and owns the whole async lifecycle, so a caller cannot leave a promise floating
 * (Sonar typescript:S9383): a rejection the check path does not handle itself (`onError` throwing,
 * closing the connection failing) becomes one FATAL line and a non-zero exit code.
 */
export function runDbCheck(options: DbCheckOptions): void {
  executeDbCheck(options).catch((error: unknown) => {
    process.stderr.write(`FATAL: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}

interface DbCheckOptions {
  check: (sql: postgres.Sql) => Promise<void>
  successMessage: string
  onError: (error: unknown) => void
}

async function executeDbCheck(options: DbCheckOptions): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL']
  if (!databaseUrl) {
    process.stderr.write('FATAL: DATABASE_URL is not set\n')
    process.exit(1)
    return
  }

  const sql = postgres(databaseUrl, pgTlsOptions())
  try {
    await options.check(sql)
    process.stdout.write(`${options.successMessage}\n`)
  } catch (error) {
    options.onError(error)
    process.exitCode = 1
  } finally {
    await sql.end()
  }
}
