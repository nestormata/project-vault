import postgres from 'postgres'

/**
 * Shared CLI-script boilerplate for a one-shot DB integrity check (`check-rls-coverage.ts`,
 * `check-audit-actor-token-coverage.ts`, ...): reads `DATABASE_URL`, connects, runs `check`, and
 * writes `successMessage` to stdout on success. Any thrown error is handed to `onError` for
 * check-specific formatting, after which the process exits non-zero. The connection is always
 * closed, success or failure.
 */
export async function runDbCheck(options: {
  check: (sql: postgres.Sql) => Promise<void>
  successMessage: string
  onError: (error: unknown) => void
}): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL']
  if (!databaseUrl) {
    process.stderr.write('FATAL: DATABASE_URL is not set\n')
    process.exit(1)
    return
  }

  const sql = postgres(databaseUrl)
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
