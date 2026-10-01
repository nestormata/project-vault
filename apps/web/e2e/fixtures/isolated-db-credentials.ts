import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto'
import postgres from 'postgres'
import {
  adminDatabaseUrl,
  appDatabaseUrl,
  dbHostPort,
  superuserDatabaseUrl,
  withDatabase,
} from './db.js'

/**
 * Story 66.4 AC-5/AC-6: the isolated-stack fixture hardcodes the vault_app/vault_admin
 * credentials it hands the API, so it owns verifying them before it spawns anything. Migration
 * 0071 deliberately creates vault_admin WITHOUT a password (operators provision it), so on a fresh
 * local DB the fixture provisions it itself, but only under the guards in
 * `provisionPasswordlessVaultAdmin`. Nothing here ever prints a password, a full DSN, the ALTER
 * ROLE statement or a postgres.js error object (which carries the statement text on `query`).
 */

export type PgFailureReason =
  'auth_failed' | 'database_missing' | 'permission_denied' | 'connection_failed' | 'unknown'

// Same closed map as apps/api's admin-pool-identity (AC-4): SQLSTATE / Node errno only.
const CODES_BY_REASON: Readonly<Record<Exclude<PgFailureReason, 'unknown'>, readonly string[]>> = {
  auth_failed: ['28P01', '28000'],
  database_missing: ['3D000'],
  permission_denied: ['42501'],
  connection_failed: [
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ETIMEDOUT',
    'CONNECT_TIMEOUT',
    '57P03',
  ],
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !Object.hasOwn(err, 'code')) return undefined
  const code: unknown = (err as { code: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** Classifies a driver error by its `code` only; the message is never read. */
export function classifyPgError(err: unknown): PgFailureReason {
  const code = errorCode(err)
  if (code === undefined) return 'unknown'
  for (const [reason, codes] of Object.entries(CODES_BY_REASON)) {
    if (codes.includes(code)) return reason as PgFailureReason
  }
  return 'unknown'
}

/** `scheme://user:secret@host` -> `scheme://user:***@host` (global-setup.ts's idiom). */
export function redactDsn(url: string): string {
  return url.replace(/:[^:@]*@/, ':***@')
}

/** host:port of a Postgres URL, never its credentials. Never throws: Node's invalid-URL
 * TypeError carries the raw input (password included) on its `input` property. */
export function describeHostPort(url: string): string {
  if (!URL.canParse(url)) return 'an unparseable URL'
  const parsed = new URL(url)
  return `${parsed.hostname}:${parsed.port || '5432'}`
}

/** Throws a credential-free error naming only `source` when `url` cannot be parsed. */
export function requireParseableUrl(url: string, source: string): void {
  if (!URL.canParse(url)) {
    throw new Error(`isolated stack: ${source} is not a valid Postgres URL`)
  }
}

/** The (decoded) password of a Postgres URL. */
export function passwordFromUrl(url: string): string {
  return decodeURIComponent(new URL(url).password)
}

type IsolatedRole = 'vault_app' | 'vault_admin'

function roleOverrideVar(role: IsolatedRole): string {
  return role === 'vault_app'
    ? 'E2E_APP_DATABASE_URL'
    : 'VAULT_ADMIN_PASSWORD (or E2E_ADMIN_DATABASE_URL)'
}

export function connectFailureMessage(
  role: IsolatedRole,
  dbName: string,
  reason: PgFailureReason,
  hostPort: string
): string {
  if (reason === 'connection_failed') {
    return `isolated stack: no Postgres on ${hostPort}. Is the e2e stack up (make e2e) and DB_HOST_PORT this worktree's port?`
  }
  if (reason === 'auth_failed') {
    return `isolated stack: ${role} cannot log in to ${dbName} (auth_failed). Export ${roleOverrideVar(role)} to match your stack.`
  }
  return `isolated stack: ${role} cannot connect to ${dbName} on ${hostPort} (${reason})`
}

export function adminAuthFailedMessage(dbName: string): string {
  return (
    `isolated stack: vault_admin cannot log in to ${dbName} (auth_failed). The role has a password ` +
    'that differs from the one this fixture uses. Export VAULT_ADMIN_PASSWORD (or ' +
    'E2E_ADMIN_DATABASE_URL) to match your stack, see docs/development.md "Provision the ' +
    'vault_admin credential".'
  )
}

const PROVISIONABLE_PASSWORD_RE = /^[A-Za-z0-9._~-]{1,128}$/

/** AC-6 (c): URL-safe, so it is valid both inside the DSN and the verifier's input. */
export function isProvisionablePassword(password: string): boolean {
  return PROVISIONABLE_PASSWORD_RE.test(password)
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * AC-6 (d): only ever give a BYPASSRLS role a known credential on THIS worktree's local cluster:
 * a loopback host on exactly DB_HOST_PORT, never a shared or remote superuser URL.
 */
export function isSafeProvisioningTarget(superuserUrl: string, hostPort: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(superuserUrl)
  } catch {
    return false
  }
  return LOOPBACK_HOSTS.has(parsed.hostname) && (parsed.port || '5432') === hostPort
}

const SCRAM_ITERATIONS = 4096

/**
 * A SCRAM-SHA-256 verifier computed client-side (RFC 5803 storage format, RFC 7677 derivation;
 * what `psql \password` sends), so the plaintext never reaches the server, its statement log,
 * pg_stat_activity or pg_stat_statements.
 */
export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(16)): string {
  const saltedPassword = pbkdf2Sync(password, salt, SCRAM_ITERATIONS, 32, 'sha256')
  const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest()
  const storedKey = createHash('sha256').update(clientKey).digest('base64')
  const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest('base64')
  return `SCRAM-SHA-256$${SCRAM_ITERATIONS}:${salt.toString('base64')}$${storedKey}:${serverKey}`
}

const SCRAM_VERIFIER_RE = /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/
// Fixed key for pg_advisory_xact_lock: serialises concurrent fixtures provisioning one cluster.
const PROVISION_LOCK_KEY = 66_040_001

const PREFLIGHT_OPTIONS = { max: 1, connect_timeout: 5, idle_timeout: 1 } as const

/** AC-5 (2): one `SELECT 1` as the role; null on success, else the code-derived reason. */
export async function preflightRole(url: string): Promise<PgFailureReason | null> {
  const sql = postgres(url, PREFLIGHT_OPTIONS)
  try {
    await sql`select 1`
    return null
  } catch (err) {
    return classifyPgError(err)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

function sqlstateOf(err: unknown): string {
  const code = errorCode(err)
  return code !== undefined && /^[0-9A-Z_]{1,32}$/.test(code) ? code : 'unknown'
}

type PasswordState = 'passwordless' | 'has-password' | 'missing'

async function vaultAdminPasswordState(
  sql: postgres.Sql | postgres.TransactionSql
): Promise<PasswordState> {
  // Only the boolean is selected; the stored verifier never leaves the server.
  const rows = await sql<{ passwordless: boolean }[]>`
    select rolpassword is null as passwordless from pg_authid where rolname = 'vault_admin'
  `
  const row = rows[0]
  if (!row) return 'missing'
  return row.passwordless ? 'passwordless' : 'has-password'
}

const CONFIRM_HINT =
  ' Set E2E_CONFIRM_DB_RESET=true to let the fixture provision a passwordless vault_admin on a ' +
  'local stack, or run the ALTER ROLE in docs/development.md step 3.'

/**
 * AC-6: provisions vault_admin's credential ONLY when (a) E2E_CONFIRM_DB_RESET=true, (b) the role
 * exists and has no password, (c) the password is URL-safe and (d) the superuser URL is this
 * worktree's loopback DB_HOST_PORT. Never overwrites an existing password, never creates the role,
 * never touches vault_app. Returns true when it provisioned, false when (b) was already false.
 */
export async function provisionPasswordlessVaultAdmin(options: {
  dbName: string
  password: string
  /** The vault_admin URL the API will use: must target the same local cluster as the superuser
   * URL, or the fixture would set the local role's credential to one meant for another server. */
  adminUrl: string
}): Promise<boolean> {
  const port = dbHostPort()
  if (process.env['E2E_CONFIRM_DB_RESET'] !== 'true') {
    throw new Error(
      `isolated stack: vault_admin cannot log in to ${options.dbName} (auth_failed).${CONFIRM_HINT}`
    )
  }
  const superuserUrl = superuserDatabaseUrl()
  if (!isSafeProvisioningTarget(superuserUrl, port)) {
    throw new Error(
      `isolated stack: refusing to provision vault_admin on a non-loopback or non-DB_HOST_PORT superuser URL (${describeHostPort(superuserUrl)}, DB_HOST_PORT=${port})`
    )
  }
  if (!isSafeProvisioningTarget(options.adminUrl, port)) {
    throw new Error(
      `isolated stack: refusing to provision vault_admin: its URL (${describeHostPort(options.adminUrl)}) is not this worktree's loopback DB_HOST_PORT=${port}`
    )
  }
  if (!isProvisionablePassword(options.password)) {
    throw new Error(
      'isolated stack: VAULT_ADMIN_PASSWORD contains characters the isolated fixture will not put in a DSN/ALTER ROLE'
    )
  }

  const sql = postgres(superuserUrl, PREFLIGHT_OPTIONS)
  try {
    let state: PasswordState
    try {
      state = await vaultAdminPasswordState(sql)
    } catch (err) {
      throw new Error(
        `isolated stack: superuser connection failed (${classifyPgError(err)}); cannot check or provision vault_admin`
      )
    }
    if (state === 'missing') {
      throw new Error(
        `isolated stack: role vault_admin does not exist on localhost:${port}; run the e2e stack (make e2e) or pnpm db:migrate first`
      )
    }
    if (state === 'has-password') return false
    return await setVaultAdminVerifier(sql, options.password)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

async function setVaultAdminVerifier(sql: postgres.Sql, password: string): Promise<boolean> {
  const verifier = scramSha256Verifier(password)
  if (!SCRAM_VERIFIER_RE.test(verifier)) {
    throw new Error('isolated stack: could not provision vault_admin (verifier)')
  }
  try {
    return await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${PROVISION_LOCK_KEY})`
      await tx.unsafe("set local log_statement = 'none'")
      await tx.unsafe("set local log_min_error_statement = 'panic'")
      // Re-check under the lock: a concurrent fixture may have provisioned it meanwhile.
      if ((await vaultAdminPasswordState(tx)) !== 'passwordless') return false
      // ALTER ROLE takes no bind parameters; the verifier is regex-checked base64 + fixed syntax.
      await tx.unsafe(`alter role vault_admin password '${verifier}'`)
      return true
    })
  } catch (err) {
    // Never rethrow the postgres.js error: it carries the statement text on `err.query`.
    throw new Error(`isolated stack: could not provision vault_admin (${sqlstateOf(err)})`)
  }
}

/**
 * AC-5/AC-6: verifies both credentials the isolated API will use against `dbName` before it is
 * spawned, provisioning a passwordless vault_admin when the AC-6 guards allow. Returns the two
 * URLs to hand the API. Throws an actionable, credential-free error otherwise.
 */
export async function ensureIsolatedDbCredentials(dbName: string): Promise<{
  appUrl: string
  adminUrl: string
}> {
  const port = dbHostPort()
  const appUrl = withDatabase(appDatabaseUrl(), dbName)
  const adminUrl = withDatabase(adminDatabaseUrl(), dbName)
  requireParseableUrl(appUrl, 'E2E_APP_DATABASE_URL')
  requireParseableUrl(adminUrl, 'E2E_ADMIN_DATABASE_URL')

  const appFailure = await preflightRole(appUrl)
  if (appFailure) {
    throw new Error(
      connectFailureMessage('vault_app', dbName, appFailure, describeHostPort(appUrl))
    )
  }

  const adminFailure = await preflightRole(adminUrl)
  if (adminFailure === null) return { appUrl, adminUrl }
  if (adminFailure !== 'auth_failed') {
    throw new Error(
      connectFailureMessage('vault_admin', dbName, adminFailure, describeHostPort(adminUrl))
    )
  }

  const provisioned = await provisionPasswordlessVaultAdmin({
    dbName,
    password: passwordFromUrl(adminUrl),
    adminUrl,
  })
  if (!provisioned) throw new Error(adminAuthFailedMessage(dbName))
  process.stdout.write(
    `[isolated-stack] provisioned vault_admin credential on localhost:${port} (role had no password)\n`
  )

  const stillFailing = await preflightRole(adminUrl)
  if (stillFailing) {
    throw new Error(
      `isolated stack: provisioned vault_admin but it still cannot log in (${stillFailing}); check pg_hba.conf`
    )
  }
  return { appUrl, adminUrl }
}
