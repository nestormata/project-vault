import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { lt, eq } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { users } from '@project-vault/db/schema'
import {
  bootstrapRouteIntegrationTest,
  registerAndLoginViaApi,
  cookieHeader,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createUnsealedRouteSuite } from '../../__tests__/helpers/unsealed-route-suite-test-helpers.js'

const { createApp: _createApp, initVault } = await bootstrapRouteIntegrationTest()
const suite = createUnsealedRouteSuite(initVault, 'operator-bootstrap-passphrase12')
suite.registerLifecycle()

function uniqueEmail(label: string): string {
  return `${label}-${randomUUID()}@example.com`
}

function uniqueOrgName(label: string): string {
  return `${label} ${randomUUID()}`
}

const TEST_PASSWORD = 'correct-horse-battery-staple9'

async function readUser(userId: string) {
  const [row] = await getDb()
    .select({ isPlatformOperator: users.isPlatformOperator, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, userId))
  if (!row) throw new Error('user not found')
  return row
}

/** Number of user rows that existed strictly before `createdAt` — robust against concurrently
 * running test files inserting users AFTER this point (unlike a plain "count of all others"). */
async function countUsersCreatedBefore(createdAt: Date): Promise<number> {
  const rows = await getDb()
    .select({ id: users.id })
    .from(users)
    .where(lt(users.createdAt, createdAt))
  return rows.length
}

describe('Story 9.1 D1/AC-1: platform operator bootstrap', () => {
  it('flags a user is_platform_operator=true iff no other user existed before it (AC-1 happy path)', async () => {
    const { userId } = await registerAndLoginViaApi(suite.app, {
      email: uniqueEmail('alice'),
      password: TEST_PASSWORD,
      orgName: uniqueOrgName('Acme Corp'),
    })

    const row = await readUser(userId)
    const priorCount = await countUsersCreatedBefore(row.createdAt)

    expect(row.isPlatformOperator).toBe(priorCount === 0)
  })

  it('flags every subsequent registration is_platform_operator=false (AC-1)', async () => {
    // Register user A first so the table is guaranteed non-empty by the time B registers,
    // regardless of whatever else is in the shared test database.
    await registerAndLoginViaApi(suite.app, {
      email: uniqueEmail('first'),
      password: TEST_PASSWORD,
      orgName: uniqueOrgName('First Co'),
    })

    const { userId: bobId } = await registerAndLoginViaApi(suite.app, {
      email: uniqueEmail('bob'),
      password: 'another-strong-pw1',
      orgName: uniqueOrgName('Other Co'),
    })

    const bobRow = await readUser(bobId)
    expect(bobRow.isPlatformOperator).toBe(false)
  })

  it('a race between two concurrent first-registrations never yields more than one operator, and both requests still succeed (AC-1 concurrency)', async () => {
    const { insertUserWithPlatformOperatorBootstrap } = await import('./service.js')
    const { hashUserPassword } = await import('./password.js')
    const passwordHash = await hashUserPassword(TEST_PASSWORD)
    const emailA = uniqueEmail('race-a')
    const emailB = uniqueEmail('race-b')

    // The shared test database may or may not already have a platform operator by the time this
    // test runs (depending on execution order across this whole suite) — check first so the
    // expectation below is deterministic either way, rather than assuming a pristine "zero users"
    // precondition that a shared integration database can't reliably guarantee.
    const existingOperators = await getDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isPlatformOperator, true))
    const operatorAlreadyExists = existingOperators.length > 0

    // Both attempts believe they are the first user on the instance (isFirstUser: true) —
    // exercises the exact retry-on-unique-violation mechanics the real registration race
    // depends on, without requiring the whole shared test database to genuinely have zero rows.
    const [resultA, resultB] = await Promise.all([
      getDb().transaction((tx) =>
        insertUserWithPlatformOperatorBootstrap(tx as never, { email: emailA, passwordHash }, true)
      ),
      getDb().transaction((tx) =>
        insertUserWithPlatformOperatorBootstrap(tx as never, { email: emailB, passwordHash }, true)
      ),
    ])

    // Neither concurrent attempt is allowed to fail outright — the loser of the race always
    // still succeeds as an ordinary registration (AC-1).
    expect(resultA.id).toBeTruthy()
    expect(resultB.id).toBeTruthy()

    const [rowA, rowB] = await Promise.all([readUser(resultA.id), readUser(resultB.id)])
    const newOperatorCount = [rowA.isPlatformOperator, rowB.isPlatformOperator].filter(
      Boolean
    ).length
    // If an operator already existed globally, both of these "I'm first" attempts correctly lose
    // (0 new operators); otherwise exactly one of the two wins. Either way, never more than one.
    expect(newOperatorCount).toBe(operatorAlreadyExists ? 0 : 1)
  })

  it('backup/restore endpoints require platform operator privileges — 403 for a non-operator, 401 unauthenticated (AC-1)', async () => {
    await registerAndLoginViaApi(suite.app, {
      email: uniqueEmail('operator-guard-first'),
      password: TEST_PASSWORD,
      orgName: uniqueOrgName('Guard First Co'),
    })
    const bob = await registerAndLoginViaApi(suite.app, {
      email: uniqueEmail('operator-guard-bob'),
      password: 'another-strong-pw1',
      orgName: uniqueOrgName('Guard Other Co'),
    })

    const forbidden = await suite.app.inject({
      method: 'POST',
      url: '/api/v1/admin/backup/trigger',
      headers: { cookie: cookieHeader(bob.cookies) },
    })
    expect(forbidden.statusCode).toBe(403)
    expect(forbidden.json()).toMatchObject({ code: 'platform_operator_required' })

    const unauthenticated = await suite.app.inject({
      method: 'POST',
      url: '/api/v1/admin/backup/trigger',
    })
    expect(unauthenticated.statusCode).toBe(401)
    expect(unauthenticated.json()).toMatchObject({ code: 'access_token_missing' })
  })
})
