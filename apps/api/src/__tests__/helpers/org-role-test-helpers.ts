import { randomUUID } from 'node:crypto'
import { getDb, withOrg } from '@project-vault/db'
import { orgMemberships, organizations, userIdentityTokens, users } from '@project-vault/db/schema'
import type { createApp } from '../../app.js'
import { firstActorTokenIdForUser } from '../../modules/audit/actor-token.js'
import { createLoginSessionInTx } from '../../modules/auth/service.js'

type TestApp = Awaited<ReturnType<typeof createApp>>
type TestAppWithJwt = TestApp & {
  jwt: {
    sign: (
      payload: Record<string, unknown>,
      options: { jti: string; expiresIn: number }
    ) => Promise<string>
  }
}

export async function loginExistingUserInOrg(
  app: TestApp,
  input: { userId: string; orgId: string; role: 'viewer' | 'member' | 'admin' | 'owner' }
) {
  const result = await withOrg(input.orgId, async (tx) => {
    await tx.insert(orgMemberships).values({
      orgId: input.orgId,
      userId: input.userId,
      role: input.role,
      status: 'active',
    })
    // Code-review finding (Story 8.1): look up the user's real identity token (the same
    // production lookup writeHumanAuditEntryOrFailClosed uses) instead of hardcoding
    // identityTokenId: null — this helper is called both for users minted bare, registration-free
    // (createDirectAuthenticatedUser below, which creates a token row before calling this) and
    // for already-registered users being granted access to a second org directly (many existing
    // test files' pattern). Hardcoding null silently discarded a real, already-existing token in
    // the latter case. A null actor_token_id on an actor_type='human' row permanently fails
    // checkAuditActorTokenCoverage (packages/db/src/check-audit-actor-token-coverage.ts), since
    // audit_log_entries is append-only and never cleaned up between test runs.
    const identityTokenId = await firstActorTokenIdForUser(tx, input.userId)
    return createLoginSessionInTx(tx, { id: input.userId, identityTokenId }, input.orgId, {})
  })
  const jwt = await (app as TestAppWithJwt).jwt.sign(
    {
      sub: result.tokens.accessClaims.sub,
      orgId: result.tokens.accessClaims.orgId,
      sessionVersion: result.tokens.accessClaims.sessionVersion,
    },
    { jti: result.tokens.accessClaims.jti, expiresIn: result.tokens.accessMaxAgeSec }
  )
  return { 'access-token': jwt }
}

export async function createDirectAuthenticatedUser(
  app: TestApp,
  label: string,
  role: 'viewer' | 'member' | 'admin' | 'owner' = 'member',
  emailPrefix = 'role-test'
) {
  const orgId = randomUUID()
  const suffix = orgId.slice(0, 8)
  await getDb()
    .insert(organizations)
    .values({
      id: orgId,
      name: `${emailPrefix} ${label} ${suffix}`,
      slug: `${emailPrefix}-${label}-${suffix}`,
    })
  const email = `${emailPrefix}-${label}-${randomUUID()}@example.com`
  const [user] = await getDb()
    .insert(users)
    .values({ email, passwordHash: 'x' })
    .returning({ id: users.id })
  if (!user) throw new Error('expected test user to be inserted')
  // Code-review finding (Story 8.1): a real user_identity_tokens row, mirroring what the actual
  // registration flow creates in the same transaction (auth/service.ts's registerUser) — a bare
  // `users` insert with no identity token produces a permanent actor-token-coverage gap the
  // moment this user's session-creation audit row (or any subsequent audit row for them) is
  // written with actor_token_id: null (see checkAuditActorTokenCoverage).
  const [identityToken] = await getDb()
    .insert(userIdentityTokens)
    .values({ userId: user.id, displayName: email })
    .returning({ id: userIdentityTokens.id })
  if (!identityToken) throw new Error('expected identity token to be inserted')
  const cookies = await loginExistingUserInOrg(app, { userId: user.id, orgId, role })
  return { userId: user.id, orgId, cookies }
}
