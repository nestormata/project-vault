import { describe, expect, it, vi } from 'vitest'
import {
  adminPoolIdentityFailure,
  classifyAdminPoolError,
  inspectAdminPoolIdentity,
  type AdminPoolUnreachableReason,
} from './admin-pool-identity.js'

describe('admin pool identity verification', () => {
  it.each([
    [{ current_user: 'vault_admin', rolsuper: false, rolbypassrls: true }, 'ok'],
    [{ current_user: 'postgres', rolsuper: true, rolbypassrls: true }, 'superuser'],
    [{ current_user: 'vault_admin', rolsuper: false, rolbypassrls: false }, 'no-bypassrls'],
  ] as const)('classifies %j as %s', async (row, status) => {
    const execute = vi.fn(async () => [row])
    await expect(inspectAdminPoolIdentity(execute)).resolves.toMatchObject({ status })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('classifies a failed query as unreachable without exposing driver details', async () => {
    const execute = vi.fn(async () => {
      throw new Error('password=secret host=example.invalid')
    })
    const result = await inspectAdminPoolIdentity(execute)
    expect(result).toEqual({ status: 'unreachable', reason: 'unknown' })
    if (result.status !== 'unreachable') throw new Error('expected unreachable')
    const message = adminPoolIdentityFailure(result).message
    expect(message).not.toContain('secret')
    expect(message).not.toContain('example.invalid')
  })

  it('classifies a missing role row as unreachable (role_row_missing)', async () => {
    await expect(inspectAdminPoolIdentity(async () => [])).resolves.toEqual({
      status: 'unreachable',
      reason: 'role_row_missing',
    })
  })

  // Story 66.4 AC-4: the reason comes from the error's `code` only, via a closed map.
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
  ] as const)('maps driver code %s to %s', async (code, reason) => {
    const execute = vi.fn(async () => {
      throw Object.assign(new Error('password=secret host=example.invalid'), { code })
    })
    await expect(inspectAdminPoolIdentity(execute)).resolves.toEqual({
      status: 'unreachable',
      reason,
    })
  })

  it('classifies a dual-stack AggregateError with an empty message by its code', () => {
    const err = Object.assign(new AggregateError([new Error('a'), new Error('b')], ''), {
      code: 'ECONNREFUSED',
    })
    expect(classifyAdminPoolError(err)).toBe('connection_failed')
  })

  it('classifies a drizzle query wrapper by its cause code, never its message', () => {
    const driverError = Object.assign(new Error('password authentication failed'), {
      code: '28P01',
    })
    const wrapper = new Error('Failed query: SELECT 1\nparams: ECONNREFUSED', {
      cause: driverError,
    })
    expect(classifyAdminPoolError(wrapper)).toBe('auth_failed')
  })

  it('stops following a cause chain after a bounded depth', () => {
    let err: Error = Object.assign(new Error('deep'), { code: '28P01' })
    for (let i = 0; i < 5; i += 1) err = new Error('wrapper', { cause: err })
    expect(classifyAdminPoolError(err)).toBe('unknown')
  })

  it.each([
    ['a string throw', 'ECONNREFUSED'],
    ['null', null],
    ['undefined', undefined],
    ['a numeric code', { code: 28 }],
    ['a message that names a code', new Error('28P01 ECONNREFUSED')],
    ['an inherited-only code', Object.create({ code: '28P01' })],
  ] as const)('classifies %s as unknown', (_label, thrown) => {
    expect(classifyAdminPoolError(thrown)).toBe('unknown')
  })

  it.each([
    ['superuser', /superuser/],
    ['no-bypassrls', /without BYPASSRLS/],
    ['unreachable', /could not reach/],
  ] as const)('builds a safe startup failure for %s', (status, expectedMessage) => {
    const error = adminPoolIdentityFailure({ status })

    expect(error).toBeInstanceOf(Error)
    expect(error.message).toMatch(expectedMessage)
    expect(error.message).not.toContain('password')
  })

  it.each([
    ['auth_failed', /\(reason: auth_failed\); provision the role's credential/],
    ['database_missing', /\(reason: database_missing\); the database in ADMIN_DATABASE_URL/],
    ['permission_denied', /\(reason: permission_denied\); the role lacks CONNECT/],
    ['connection_failed', /\(reason: connection_failed\); the database host is unreachable/],
    ['role_row_missing', /\(reason: role_row_missing\); the role does not exist in pg_roles/],
    ['unknown', /\(reason: unknown\); run the Story 24.2 migration/],
  ] as const satisfies ReadonlyArray<readonly [AdminPoolUnreachableReason, RegExp]>)(
    'renders the unreachable reason %s with a credential-word-free hint',
    (reason, expected) => {
      const error = adminPoolIdentityFailure({ status: 'unreachable', reason })
      expect(error.message).toMatch(
        /^API will not start: ADMIN_DATABASE_URL could not reach the configured role \(reason: /
      )
      expect(error.message).toMatch(expected)
      expect(error.message).not.toContain('password')
    }
  )
})
