import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { getDb, withOrg, type Tx } from '@project-vault/db'
import {
  externalIdentities,
  organizations,
  orgMemberships,
  userIdentityTokens,
  users,
} from '@project-vault/db/schema'
import { and, eq } from 'drizzle-orm'

/**
 * Story 71.3 — shared fixtures for the delegated-assertion integration suites. Assertions are
 * signed with an Ed25519 key generated in-process (nothing is read from disk or env). A test file
 * must still assign `process.env['VAULT_DELEGATION_VERIFY_KEYS']` and
 * `process.env['VAULT_HANDOFF_INSTANCE_ID']` itself, at its top and before importing the app:
 * env is read when the module loads. Use `DELEGATION_TEST_*` and `delegationTestVerifyKeysJson()`.
 */

const primary = generateKeyPairSync('ed25519')
const other = generateKeyPairSync('ed25519')
const primaryPem = primary.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
const otherPem = other.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()

export const DELEGATION_TEST_INSTANCE_ID = 'pv-delegation-stage-test'
export const DELEGATION_TEST_KID = 'cm-deleg-test-1'
export const DELEGATION_TEST_ISSUER = 'https://app.centralizeme.com'
export const DELEGATION_TEST_PROVIDER = 'centralizeme-handoff'

export function delegationTestVerifyKeysJson(): string {
  return JSON.stringify([
    {
      kid: DELEGATION_TEST_KID,
      publicKeyPem: primary.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    },
  ])
}

/**
 * Several configured key ids that all verify against the SAME test key (the header `kid` picks the
 * id): lets one test file spend a limiter bucket per kid without sharing process-wide state.
 */
export function delegationTestVerifyKeysJsonFor(kids: readonly string[]): string {
  const publicKeyPem = primary.publicKey.export({ format: 'pem', type: 'spki' }).toString()
  return JSON.stringify(kids.map((kid) => ({ kid, publicKeyPem })))
}

export function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

/** The `bsh` claim for a body: base64url SHA-256 of the exact bytes, 43 characters. */
export function bodyHashOf(body: Buffer | string = ''): string {
  return createHash('sha256').update(body).digest('base64url')
}

export type AssertionOptions = {
  claims?: Record<string, unknown>
  header?: Record<string, unknown>
  /** Sign with a key that is NOT in the verification key set (a bad signature for a known kid). */
  wrongKey?: boolean
  /** Claim names to delete before signing. */
  omit?: string[]
  /** Sign this exact payload text instead of the claims (a validly signed but malformed payload). */
  rawPayload?: string
}

/** Signs a delegation assertion whose defaults describe a valid request for `op` / `body`. */
export function signDelegationAssertion(
  base: { org: string; sub: string; op: string; body?: Buffer | string },
  options: AssertionOptions = {}
): string {
  const now = Math.floor(Date.now() / 1000)
  const claims: Record<string, unknown> = {
    ver: 1,
    iss: DELEGATION_TEST_ISSUER,
    aud: `pvd:${DELEGATION_TEST_INSTANCE_ID}`,
    iat: now,
    exp: now + 45,
    jti: `jti-${randomUUID()}`,
    org: base.org,
    act: { prv: DELEGATION_TEST_PROVIDER, sub: base.sub },
    op: base.op,
    bsh: bodyHashOf(base.body ?? ''),
    ...options.claims,
  }
  const omitted = new Set(options.omit ?? [])
  const payload = Object.fromEntries(Object.entries(claims).filter(([name]) => !omitted.has(name)))
  const header = {
    alg: 'EdDSA',
    typ: 'pv-delegation+jwt',
    kid: DELEGATION_TEST_KID,
    ...options.header,
  }
  const payloadText = options.rawPayload ?? JSON.stringify(payload)
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(payloadText)}`
  const key = createPrivateKey({ key: options.wrongKey ? otherPem : primaryPem, format: 'pem' })
  return `${signingInput}.${b64url(sign(null, Buffer.from(signingInput), key))}`
}

export type DelegationOrgFixture = {
  orgId: string
  cmOrgId: string
}

/** A PV org linked to a fresh CentralizeMe organization id. */
export async function createDelegationOrg(label: string): Promise<DelegationOrgFixture> {
  const orgId = randomUUID()
  const cmOrgId = `cm-org-${randomUUID()}`
  const suffix = orgId.slice(0, 8)
  await getDb()
    .insert(organizations)
    .values({
      id: orgId,
      name: `deleg-${label}-${suffix}`,
      slug: `deleg-${label}-${suffix}`,
      centralizemeOrganizationId: cmOrgId,
    })
  return { orgId, cmOrgId }
}

async function createUser(label: string): Promise<string> {
  const email = `deleg-${label}-${randomUUID()}@example.com`
  const [user] = await getDb()
    .insert(users)
    .values({ email, passwordHash: 'x' })
    .returning({ id: users.id })
  if (!user) throw new Error('expected user row')
  await getDb().insert(userIdentityTokens).values({ userId: user.id, displayName: email })
  return user.id
}

export type LinkedActorOptions = {
  role?: 'owner' | 'admin' | 'member' | 'viewer'
  /** `none` links the actor but creates no membership row in the org. */
  membership?: 'active' | 'deactivated' | 'none'
}

/**
 * Links `subject` (provider `DELEGATION_TEST_PROVIDER`) to a new PV user in `orgId`, with an
 * active membership by default.
 */
export async function linkDelegationActor(
  orgId: string,
  subject: string,
  options: LinkedActorOptions = {}
): Promise<{ userId: string }> {
  const userId = await createUser('actor')
  const membership = options.membership ?? 'active'
  await withOrg(orgId, async (tx) => {
    if (membership !== 'none') {
      await (tx as Tx).insert(orgMemberships).values({
        orgId,
        userId,
        role: options.role ?? 'member',
        status: membership,
      })
    }
    await (tx as Tx).insert(externalIdentities).values({
      orgId,
      userId,
      providerName: DELEGATION_TEST_PROVIDER,
      externalSubject: subject,
    })
  })
  return { userId }
}

export async function countBurnedAssertions(orgId: string, jti?: string): Promise<number> {
  const { delegationAssertionJti } = await import('@project-vault/db/schema')
  return withOrg(orgId, async (tx) => {
    const rows = await (tx as Tx)
      .select({ jti: delegationAssertionJti.jti })
      .from(delegationAssertionJti)
      .where(
        jti === undefined
          ? eq(delegationAssertionJti.orgId, orgId)
          : and(eq(delegationAssertionJti.orgId, orgId), eq(delegationAssertionJti.jti, jti))
      )
    return rows.length
  })
}

export type DelegationCounterSample = { outcome: string; kid: string; value: number }

/** Every `pv_delegation_assertions_total` series currently in the registry (Story 71.9). */
export async function delegationCounterSamples(): Promise<DelegationCounterSample[]> {
  const { register } = await import('prom-client')
  const snapshot = await register.getSingleMetric('pv_delegation_assertions_total')?.get()
  return (snapshot?.values ?? []).map((sample) => ({
    outcome: String(sample.labels['outcome']),
    kid: String(sample.labels['kid']),
    value: sample.value,
  }))
}

/** The counter summed across `kid`, one number per outcome. */
export function totalsByOutcome(samples: DelegationCounterSample[]): Record<string, number> {
  const totals = new Map<string, number>()
  for (const sample of samples) {
    totals.set(sample.outcome, (totals.get(sample.outcome) ?? 0) + sample.value)
  }
  return Object.fromEntries(totals)
}

/** How much each outcome total grew between two snapshots (only the outcomes that moved). */
export function counterDeltas(
  before: Record<string, number>,
  after: Record<string, number>
): Record<string, number> {
  const earlier = new Map(Object.entries(before))
  const later = new Map(Object.entries(after))
  const deltas = new Map<string, number>()
  for (const outcome of new Set([...earlier.keys(), ...later.keys()])) {
    const grew = (later.get(outcome) ?? 0) - (earlier.get(outcome) ?? 0)
    if (grew !== 0) deltas.set(outcome, grew)
  }
  return Object.fromEntries(deltas)
}
