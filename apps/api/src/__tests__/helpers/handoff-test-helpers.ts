import { generateKeyPairSync, sign as cryptoSign, createPrivateKey, randomUUID } from 'node:crypto'
import { getDb, withOrg, type Tx } from '@project-vault/db'
import { parseSetCookies } from './auth-test-helpers.js'
import {
  externalIdentities,
  organizations,
  orgMemberships,
  userIdentityTokens,
  users,
} from '@project-vault/db/schema'

/**
 * Shared fixtures for the handoff route integration tests (`handoff-routes.test.ts`,
 * `handoff-claim-exchange-atomicity.test.ts` — Story 60.5 Task 2.1).
 *
 * Each test file must still assign `process.env['VAULT_HANDOFF_*']` itself, at its top and before
 * `bootstrapRouteIntegrationTest()`: env is read when the app module loads. Use
 * `HANDOFF_TEST_INSTANCE_ID`, `HANDOFF_TEST_KID` and `handoffTestPublicKeyPem` for that.
 */

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
export const handoffTestPublicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString()
const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()

export const HANDOFF_TEST_INSTANCE_ID = 'pv-handoff-route-test'
export const HANDOFF_TEST_KID = 'kid-1'
export const HANDOFF_PROVIDER = 'centralizeme-handoff'
export const HANDOFF_COOKIE_NAME = 'handoff-confirm'

/** The handoff pending-state cookie value a response set, if any (Map lookup, no dynamic key). */
export function handoffCookieFrom(setCookie: string | string[] | undefined): string | undefined {
  return new Map(Object.entries(parseSetCookies(setCookie))).get(HANDOFF_COOKIE_NAME)
}

export function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

export function signToken(claimOverrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'EdDSA', kid: HANDOFF_TEST_KID, typ: 'JWT' }
  const payload = {
    iss: 'https://app.centralizeme.com',
    aud: `pv:${HANDOFF_TEST_INSTANCE_ID}`,
    iat: now,
    exp: now + 30,
    jti: `jti-${randomUUID()}`,
    workosUserId: `user_${randomUUID()}`,
    providerName: HANDOFF_PROVIDER,
    organizationId: randomUUID(),
    instanceId: HANDOFF_TEST_INSTANCE_ID,
    tier: 'pro',
    capabilities: [],
    claimsVersion: 1,
    ...claimOverrides,
  }
  const headerPart = b64url(JSON.stringify(header))
  const payloadPart = b64url(JSON.stringify(payload))
  const signingInput = `${headerPart}.${payloadPart}`
  const key = createPrivateKey({ key: privateKeyPem, format: 'pem' })
  const signature = cryptoSign(null, Buffer.from(signingInput), key)
  return `${signingInput}.${b64url(signature)}`
}

/**
 * Story 30.2: creates a PV org + active member linked to `workosUserId` via `HANDOFF_PROVIDER`,
 * with `centralizemeOrganizationId` stored on the org row — the fixture needed for
 * burnAndResolveOrg's real, stored-value comparison (never a raw-UUID comparison against the
 * token's `organizationId` claim).
 *
 * Story 60.4: `options.email` overrides the linked user's `users.email` (default unchanged), so
 * prepare's display-label nulling can be exercised with a synthetic service-provisioned address.
 */
export async function createLinkedHandoffOrg(
  label: string,
  workosUserId: string,
  centralizemeOrganizationId: string,
  options: { email?: string } = {}
): Promise<{ orgId: string; userId: string; organizationName: string }> {
  const orgId = randomUUID()
  const suffix = orgId.slice(0, 8)
  await getDb()
    .insert(organizations)
    .values({
      id: orgId,
      name: `handoff-${label}-${suffix}`,
      slug: `handoff-${label}-${suffix}`,
      centralizemeOrganizationId,
    })
  const email = options.email ?? `handoff-${label}-${randomUUID()}@example.com`
  const [user] = await getDb()
    .insert(users)
    .values({ email, passwordHash: 'x' })
    .returning({ id: users.id })
  if (!user) throw new Error('expected user row')
  await getDb().insert(userIdentityTokens).values({ userId: user.id, displayName: email })
  await withOrg(orgId, (tx) =>
    (tx as Tx)
      .insert(orgMemberships)
      .values({ orgId, userId: user.id, role: 'member', status: 'active' })
  )
  await withOrg(orgId, (tx) =>
    (tx as Tx).insert(externalIdentities).values({
      orgId,
      userId: user.id,
      providerName: HANDOFF_PROVIDER,
      externalSubject: workosUserId,
    })
  )
  return { orgId, userId: user.id, organizationName: `handoff-${label}-${suffix}` }
}
