import { randomUUID } from 'node:crypto'
import { getDb, withOrg } from '@project-vault/db'
import { orgMemberships, organizations, users } from '@project-vault/db/schema'
import type { createApp } from '../../app.js'
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
  input: { userId: string; orgId: string; role: 'viewer' | 'member' | 'admin' }
) {
  const result = await withOrg(input.orgId, async (tx) => {
    await tx.insert(orgMemberships).values({
      orgId: input.orgId,
      userId: input.userId,
      role: input.role,
      status: 'active',
    })
    return createLoginSessionInTx(tx, { id: input.userId, identityTokenId: null }, input.orgId, {})
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
  role: 'viewer' | 'member' | 'admin' = 'member',
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
  const [user] = await getDb()
    .insert(users)
    .values({ email: `${emailPrefix}-${label}-${randomUUID()}@example.com`, passwordHash: 'x' })
    .returning({ id: users.id })
  if (!user) throw new Error('expected test user to be inserted')
  const cookies = await loginExistingUserInOrg(app, { userId: user.id, orgId, role })
  return { userId: user.id, orgId, cookies }
}
