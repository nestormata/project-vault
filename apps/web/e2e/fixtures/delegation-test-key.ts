import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto'

/**
 * Story 71.5 D3: the TEST-ONLY signer of service-delegated actor assertions for the isolated-stack
 * journey j36 (the real-host proof of Epic 71). Nothing here is a secret and nothing here is
 * trusted by any real deployment:
 *
 * - The seed is a fixed public test seed (like handoff-test-key.ts), different from the handoff
 *   one (the host refuses a key set that shares key bytes with the handoff set). Both halves are
 *   derived from it at runtime, so no key PEM is in the repository (scripts/check-public-safety.ts).
 * - The journey puts the public half in the env of its OWN api child. It is not in
 *   docker-compose*.yml, any fly*.toml, .env.example or a production default
 *   (scripts/e2e-stack.test.ts guards that, with a planted-marker mutation test).
 * - A real deployment trusting this kid would also need `aud = pvd:pv-e2e-delegation`, an
 *   instance id that exists in no deployment.
 * - The signing function refuses to run when NODE_ENV is production or when the target API is
 *   not on a loopback host.
 */

export const DELEGATION_E2E_KID = 'pv-e2e-delegation-test-only-1'
export const DELEGATION_E2E_INSTANCE_ID = 'pv-e2e-delegation'
export const DELEGATION_E2E_ISSUER = 'https://app.centralizeme.com'
export const DELEGATION_E2E_PROVIDER = 'centralizeme-handoff'

const DELEGATION_E2E_SEED = Buffer.alloc(32, 0x61)
// The fixed DER header of an Ed25519 PKCS#8 private key (RFC 8410); the 32-byte seed follows it.
const ED25519_PKCS8_PREFIX = Buffer.concat([
  Buffer.from([0x30, 0x2e]),
  Buffer.from([0x02, 0x01, 0x00]),
  Buffer.from([0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70]),
  Buffer.from([0x04, 0x22, 0x04, 0x20]),
])

export function delegationE2ePrivateKey(): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, DELEGATION_E2E_SEED]),
    format: 'der',
    type: 'pkcs8',
  })
}

/** The public half of the fixed seed, derived at runtime (no key literal in the repository). */
export function delegationE2ePublicKeyPem(): string {
  return createPublicKey(delegationE2ePrivateKey())
    .export({ format: 'pem', type: 'spki' })
    .toString()
}

/** The value of `VAULT_DELEGATION_VERIFY_KEYS` for the journey's api child. */
export function delegationE2eVerifyKeysJson(): string {
  return JSON.stringify([{ kid: DELEGATION_E2E_KID, publicKeyPem: delegationE2ePublicKeyPem() }])
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Throws unless this process is not production and `apiBase` is a loopback URL. */
export function assertDelegationSignerAllowed(
  apiBase: string,
  env: Record<string, string | undefined> = process.env
): void {
  if (env['NODE_ENV'] === 'production') {
    throw new Error('the e2e delegation test signer refuses to run with NODE_ENV=production')
  }
  let hostname = ''
  try {
    hostname = new URL(apiBase).hostname
  } catch {
    // an unparsable target is not a loopback target
  }
  if (!LOOPBACK_HOSTS.has(hostname)) {
    throw new Error('the e2e delegation test signer only signs for a loopback api host')
  }
}

/** The `bsh` claim for a body: base64url SHA-256 of the exact bytes. */
export function delegationBodyHash(body: Buffer | string = ''): string {
  return createHash('sha256').update(body).digest('base64url')
}

export type DelegationE2eAssertionInput = {
  /** The API the assertion will be sent to; must be loopback. */
  apiBase: string
  /** CentralizeMe's organization id (`organizations.centralizeme_organization_id`). */
  org: string
  /** The actor subject (`act.sub`). */
  sub: string
  /** The route key, `METHOD /full/url`. */
  op: string
  /** The exact raw request body bytes the `bsh` claim commits to. */
  body?: Buffer | string
  /** Claims merged over the valid defaults (an explicit `occ`, `iat`, `exp`, `jti`, `aud`, ...). */
  claims?: Record<string, unknown>
  header?: Record<string, unknown>
  /** Claim names to delete before signing. */
  omit?: string[]
  /** Sign with this key instead of the delegation test key (a different key under the same kid). */
  signingKey?: KeyObject
}

/**
 * Signs a `pv-delegation+jwt` assertion whose defaults describe a valid request: 45 s lifetime
 * from now, a fresh `jti`, `aud = pvd:<test instance>`. Mint it immediately before its request.
 */
export function signDelegationE2eAssertion(input: DelegationE2eAssertionInput): string {
  assertDelegationSignerAllowed(input.apiBase)
  const now = Math.floor(Date.now() / 1000)
  const claims: Record<string, unknown> = {
    ver: 1,
    iss: DELEGATION_E2E_ISSUER,
    aud: `pvd:${DELEGATION_E2E_INSTANCE_ID}`,
    iat: now,
    exp: now + 45,
    jti: `jti-${randomUUID()}`,
    org: input.org,
    act: { prv: DELEGATION_E2E_PROVIDER, sub: input.sub },
    op: input.op,
    bsh: delegationBodyHash(input.body ?? ''),
    ...input.claims,
  }
  const omitted = new Set(input.omit ?? [])
  const payload = Object.fromEntries(Object.entries(claims).filter(([name]) => !omitted.has(name)))
  const header = {
    alg: 'EdDSA',
    typ: 'pv-delegation+jwt',
    kid: DELEGATION_E2E_KID,
    ...input.header,
  }
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const signingInput = `${encode(header)}.${encode(payload)}`
  const signature = sign(
    null,
    Buffer.from(signingInput),
    input.signingKey ?? delegationE2ePrivateKey()
  )
  return `${signingInput}.${signature.toString('base64url')}`
}
