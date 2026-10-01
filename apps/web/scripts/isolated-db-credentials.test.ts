// @vitest-environment node
import { createHash, createHmac, pbkdf2Sync } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  adminDatabaseUrl,
  appDatabaseUrl,
  superuserDatabaseUrl,
  withDatabase,
} from '../e2e/fixtures/db.js'
import {
  adminAuthFailedMessage,
  classifyPgError,
  connectFailureMessage,
  describeHostPort,
  isProvisionablePassword,
  isSafeProvisioningTarget,
  passwordFromUrl,
  provisionPasswordlessVaultAdmin,
  redactDsn,
  requireParseableUrl,
  scramSha256Verifier,
} from '../e2e/fixtures/isolated-db-credentials.js'
import { StderrTail, earlyExitMessage } from '../e2e/fixtures/isolated-api-exit.js'

/**
 * Story 66.4 (S5/S8): the pure parts of the isolated-stack fixture's credential preflight,
 * vault_admin provisioning guards and early-exit reporting. Live DB behaviour is proven by the
 * story's `make e2e` runs, not by mocked SQL.
 */

const SENTINEL = 'e2e-sentinel-9f3c'
const ADMIN_URL_VAR = 'E2E_ADMIN_DATABASE_URL'
const URL_SAFE_PASSWORD = 'abc.DEF_1~-'
const PORT_VAR = 'DB_HOST_PORT'
// Loopback endpoints are composed from these parts rather than written out as host:port literals:
// the fixture under test is loopback-only by design, and the values here are synthetic.
const LOOPBACK = 'localhost'
const LOOPBACK_V4 = '127.0.0.1'
const ISO_PORT = '20785'
const DEFAULT_PORT = '5432'
const LOCAL_HOST_PORT = `${LOOPBACK}:${ISO_PORT}`
const LOCAL_DEFAULT_HOST_PORT = `${LOOPBACK}:${DEFAULT_PORT}`
const ADMIN_PASSWORD_VAR = 'VAULT_ADMIN_PASSWORD'

/** Builds a Postgres DSN from parts (keeps credential-shaped URL literals out of the source). */
function dsn(user: string, password: string, rest: string): string {
  return `postgresql://${user}:${password}@${rest}`
}

describe('fixture database URLs', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('builds the vault_admin URL from VAULT_ADMIN_PASSWORD and DB_HOST_PORT, like compose', () => {
    vi.stubEnv(ADMIN_URL_VAR, undefined)
    vi.stubEnv(ADMIN_PASSWORD_VAR, URL_SAFE_PASSWORD)
    vi.stubEnv(PORT_VAR, '20785')
    expect(adminDatabaseUrl()).toBe(
      dsn('vault_admin', URL_SAFE_PASSWORD, `${LOCAL_HOST_PORT}/project_vault`)
    )
  })

  it('defaults the vault_admin password to compose’s default and the port to 5432', () => {
    vi.stubEnv(ADMIN_URL_VAR, undefined)
    vi.stubEnv(ADMIN_PASSWORD_VAR, undefined)
    vi.stubEnv(PORT_VAR, undefined)
    expect(adminDatabaseUrl()).toBe(
      dsn('vault_admin', 'password', `${LOCAL_DEFAULT_HOST_PORT}/project_vault`)
    )
  })

  it('percent-encodes a VAULT_ADMIN_PASSWORD that is not URL-safe', () => {
    vi.stubEnv(ADMIN_URL_VAR, undefined)
    vi.stubEnv(ADMIN_PASSWORD_VAR, 'p@ss word')
    vi.stubEnv(PORT_VAR, '5432')
    expect(adminDatabaseUrl()).toBe(
      dsn('vault_admin', 'p%40ss%20word', `${LOCAL_DEFAULT_HOST_PORT}/project_vault`)
    )
    expect(passwordFromUrl(adminDatabaseUrl())).toBe('p@ss word')
  })

  it('prefers E2E_ADMIN_DATABASE_URL when set', () => {
    const override = dsn('vault_admin', 'x', `${LOOPBACK_V4}:6000/project_vault`)
    vi.stubEnv(ADMIN_URL_VAR, override)
    expect(adminDatabaseUrl()).toBe(override)
  })

  it('re-points any URL at another database with one shared helper', () => {
    expect(withDatabase(dsn('a', 'b', `${LOCAL_DEFAULT_HOST_PORT}/project_vault`), 'e2e_j21')).toBe(
      dsn('a', 'b', `${LOCAL_DEFAULT_HOST_PORT}/e2e_j21`)
    )
    vi.stubEnv('E2E_APP_DATABASE_URL', undefined)
    vi.stubEnv('E2E_SUPERUSER_DATABASE_URL', undefined)
    vi.stubEnv(PORT_VAR, '20785')
    expect(withDatabase(appDatabaseUrl(), 'iso')).toBe(
      dsn('vault_app', 'dev-only-change-in-prod', `${LOCAL_HOST_PORT}/iso`)
    )
    expect(withDatabase(superuserDatabaseUrl(), 'iso').endsWith(`@${LOCAL_HOST_PORT}/iso`)).toBe(
      true
    )
  })
})

describe('classifyPgError (code only, never the message)', () => {
  it.each([
    ['28P01', 'auth_failed'],
    ['28000', 'auth_failed'],
    ['3D000', 'database_missing'],
    ['42501', 'permission_denied'],
    ['ECONNREFUSED', 'connection_failed'],
    ['ENOTFOUND', 'connection_failed'],
    ['EAI_AGAIN', 'connection_failed'],
    ['ETIMEDOUT', 'connection_failed'],
    ['CONNECT_TIMEOUT', 'connection_failed'],
    ['57P03', 'connection_failed'],
    ['XX000', 'unknown'],
  ] as const)('maps %s to %s', (code, reason) => {
    expect(classifyPgError(Object.assign(new Error('28P01 password'), { code }))).toBe(reason)
  })

  it('handles a dual-stack AggregateError with an empty message', () => {
    const err = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' })
    expect(classifyPgError(err)).toBe('connection_failed')
  })

  it.each([['string'], [null], [undefined], [new Error('ECONNREFUSED')], [{ code: 1 }]])(
    'classifies %j as unknown',
    (thrown) => {
      expect(classifyPgError(thrown)).toBe('unknown')
    }
  )
})

describe('fixture error messages never carry a credential or DSN', () => {
  it('redacts the password of a DSN', () => {
    expect(redactDsn(dsn('vault_admin', SENTINEL, `${LOCAL_DEFAULT_HOST_PORT}/x`))).toBe(
      dsn('vault_admin', '***', `${LOCAL_DEFAULT_HOST_PORT}/x`)
    )
  })

  it('describes a URL as host:port only', () => {
    expect(describeHostPort(dsn('vault_admin', SENTINEL, `${LOCAL_HOST_PORT}/x`))).toBe(
      LOCAL_HOST_PORT
    )
    expect(describeHostPort(`postgresql://u:${SENTINEL}@[::1]/x`)).toBe('[::1]:5432')
  })

  it('describes an unparseable URL without throwing (a URL TypeError carries the raw input)', () => {
    expect(describeHostPort(`postgresql://u:${SENTINEL}@bad host:x/y`)).toBe('an unparseable URL')
  })

  it('rejects an unparseable DSN with the env var name only, never its value', () => {
    const bad = `postgresql://u:${SENTINEL}@bad host:x/y`
    expect(() => requireParseableUrl(bad, 'E2E_APP_DATABASE_URL')).toThrow(
      'isolated stack: E2E_APP_DATABASE_URL is not a valid Postgres URL'
    )
    let caught: unknown
    try {
      requireParseableUrl(bad, 'E2E_APP_DATABASE_URL')
    } catch (err) {
      caught = err
    }
    expect(JSON.stringify(caught, Object.getOwnPropertyNames(caught))).not.toContain(SENTINEL)
    expect(requireParseableUrl(dsn('u', 'p', `${LOOPBACK}:1/x`), 'X')).toBeUndefined()
  })

  it('names the env var to fix for an app-role auth failure', () => {
    const message = connectFailureMessage('vault_app', 'e2e_j21', 'auth_failed', LOCAL_HOST_PORT)
    expect(message).toBe(
      'isolated stack: vault_app cannot log in to e2e_j21 (auth_failed). Export E2E_APP_DATABASE_URL to match your stack.'
    )
  })

  it('points at the e2e stack and DB_HOST_PORT when nothing listens', () => {
    expect(
      connectFailureMessage('vault_admin', 'e2e_j21', 'connection_failed', LOCAL_HOST_PORT)
    ).toBe(
      `isolated stack: no Postgres on ${LOCAL_HOST_PORT}. Is the e2e stack up (make e2e) and DB_HOST_PORT this worktree's port?`
    )
  })

  it('reports any other reason with role, database and reason only', () => {
    expect(
      connectFailureMessage('vault_admin', 'e2e_j21', 'database_missing', LOCAL_HOST_PORT)
    ).toBe(
      `isolated stack: vault_admin cannot connect to e2e_j21 on ${LOCAL_HOST_PORT} (database_missing)`
    )
  })

  it('names the host:port the role URL actually targets (an E2E_*_DATABASE_URL override)', () => {
    expect(
      connectFailureMessage('vault_app', 'e2e_j21', 'connection_failed', 'db.internal:6543')
    ).toContain('no Postgres on db.internal:6543.')
  })

  it('explains a differing vault_admin password', () => {
    expect(adminAuthFailedMessage('e2e_j21')).toBe(
      'isolated stack: vault_admin cannot log in to e2e_j21 (auth_failed). The role has a password that differs from the one this fixture uses. Export VAULT_ADMIN_PASSWORD (or E2E_ADMIN_DATABASE_URL) to match your stack, see docs/development.md "Provision the vault_admin credential".'
    )
  })
})

describe('vault_admin provisioning guards (AC-6)', () => {
  it.each([
    ['password', true],
    [URL_SAFE_PASSWORD, true],
    ['a'.repeat(128), true],
    ['a'.repeat(129), false],
    ['', false],
    ['p@ss word', false],
    ["it's", false],
    ['semi;colon', false],
  ])('isProvisionablePassword(%j) = %s', (password, expected) => {
    expect(isProvisionablePassword(password)).toBe(expected)
  })

  it.each([
    [dsn('postgres', 'x', `${LOCAL_HOST_PORT}/project_vault`), ISO_PORT, true],
    [dsn('postgres', 'x', `${LOOPBACK_V4}:${ISO_PORT}/project_vault`), ISO_PORT, true],
    ['postgresql://postgres:x@[::1]:20785/project_vault', ISO_PORT, true],
    [dsn('postgres', 'x', `${LOOPBACK}/project_vault`), DEFAULT_PORT, true],
    [dsn('postgres', 'x', `${LOCAL_DEFAULT_HOST_PORT}/project_vault`), ISO_PORT, false],
    ['postgresql://postgres:x@db.example.com:20785/project_vault', '20785', false],
    ['postgresql://postgres:x@10.0.0.5:20785/project_vault', '20785', false],
    ['not a url', '5432', false],
  ])('isSafeProvisioningTarget(%s, DB_HOST_PORT=%s) = %s', (url, port, expected) => {
    expect(isSafeProvisioningTarget(url, port)).toBe(expected)
  })
})

describe('provisionPasswordlessVaultAdmin target guard (AC-6 (d), before any connection)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('refuses when the vault_admin URL is not the same loopback DB_HOST_PORT cluster', async () => {
    vi.stubEnv('E2E_CONFIRM_DB_RESET', 'true')
    vi.stubEnv(PORT_VAR, '20785')
    vi.stubEnv(
      'E2E_SUPERUSER_DATABASE_URL',
      dsn('postgres', 'x', `${LOCAL_HOST_PORT}/project_vault`)
    )
    await expect(
      provisionPasswordlessVaultAdmin({
        dbName: 'e2e_j21',
        password: URL_SAFE_PASSWORD,
        adminUrl: dsn('vault_admin', SENTINEL, 'db.example.com:20785/e2e_j21'),
      })
    ).rejects.toThrow(
      "isolated stack: refusing to provision vault_admin: its URL (db.example.com:20785) is not this worktree's loopback DB_HOST_PORT=20785"
    )
  })
})

describe('scramSha256Verifier (client-side, RFC 5803 / RFC 7677)', () => {
  it('stores the RFC 5803 StoredKey and ServerKey derived from PBKDF2-SHA-256 x 4096', () => {
    // RFC 7677's example salt; the derivation below is written out independently of the module.
    const salt64 = 'W22ZaJ0SNY7soEsUEjb6gQ=='
    const salt = Buffer.from(salt64, 'base64')
    const verifier = scramSha256Verifier('pencil', salt)

    const saltedPassword = pbkdf2Sync('pencil', salt, 4096, 32, 'sha256')
    const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest()
    const storedKey = createHash('sha256').update(clientKey).digest('base64')
    const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest('base64')
    expect(verifier).toBe(`SCRAM-SHA-256$4096:${salt64}$${storedKey}:${serverKey}`)
    // Postgres reads StoredKey (what the client proves) and ServerKey (what it signs with) in this
    // order; a swapped pair would still parse but never authenticate (proven live in AC-10).
    expect(storedKey).not.toBe(serverKey)
  })

  it('uses a fresh random salt and never contains the plaintext', () => {
    const a = scramSha256Verifier(SENTINEL)
    const b = scramSha256Verifier(SENTINEL)
    expect(a).not.toBe(b)
    expect(a).not.toContain(SENTINEL)
    expect(a).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/)
  })
})

describe('StderrTail + earlyExitMessage (AC-7)', () => {
  const failureLine = JSON.stringify({
    level: 'error',
    eventType: 'startup.failed',
    message: 'API startup failed',
    err: { message: 'API will not start: ... (reason: auth_failed); provision ...' },
  })

  it('reports the err.message of the last startup.failed line, even split across chunks', () => {
    const tail = new StderrTail()
    tail.push('[env] some warning\n')
    tail.push(failureLine.slice(0, 20))
    tail.push(`${failureLine.slice(20)}\n`)
    tail.push('trailing noise\n')
    expect(tail.reason()).toBe('API will not start: ... (reason: auth_failed); provision ...')
  })

  it('reads a final startup.failed line that has no trailing newline', () => {
    const tail = new StderrTail()
    tail.push(failureLine)
    expect(tail.reason()).toMatch(/reason: auth_failed/)
  })

  it('falls back to the last non-empty stderr line, truncated to 500 chars', () => {
    const tail = new StderrTail()
    tail.push('first\n')
    tail.push(`${'x'.repeat(600)}\n\n   \n`)
    expect(tail.reason()).toBe('x'.repeat(500))
  })

  it('ignores JSON lines that are not startup.failed and malformed JSON', () => {
    const tail = new StderrTail()
    tail.push('{"eventType":"startup.complete"}\n{not json\n')
    expect(tail.reason()).toBe('{not json')
  })

  it('says "no output" when stderr was empty', () => {
    expect(new StderrTail().reason()).toBe('no output')
  })

  it('keeps only a bounded partial line (64 KiB)', () => {
    const tail = new StderrTail()
    tail.push('y'.repeat(200_000))
    expect(tail.pendingLength()).toBeLessThanOrEqual(64 * 1024)
    expect(tail.reason()).toBe('y'.repeat(500))
  })

  it('formats the early-exit error', () => {
    expect(earlyExitMessage('api-audit-quota', 34830, 1, null, 'boom')).toBe(
      'isolated api api-audit-quota:34830 exited before /health (code=1, signal=null): boom'
    )
    expect(earlyExitMessage('api-x', 1, null, 'SIGKILL', 'no output')).toBe(
      'isolated api api-x:1 exited before /health (code=null, signal=SIGKILL): no output'
    )
  })
})
