import { createSigner, createVerifier } from 'fast-jwt'
import type {
  AuthResult,
  AuthStrategy,
  ExtensionHooks,
  ExtensionManifest,
} from '@project-vault/extension-api'
import { FIXTURE_TEST_ONLY_PRIVATE_KEY, FIXTURE_TEST_ONLY_PUBLIC_KEY } from './keys.js'

/**
 * Story 23.2 AC-14/AC-15: a self-contained, in-process mock "signed-envelope" identity
 * extension — the reference fixture that proves native-login exclusion end-to-end. Modeled on
 * CentralizeMe's signed-envelope ingestion pattern (the story's own motivating example), but
 * entirely local: no network call, no real IdP, asymmetric signature verification only.
 *
 * **NEVER load this extension against a production instance.** See README.md.
 */

export const MOCK_ENVELOPE_PROVIDER_NAME = 'test.mock-envelope-extension'
const ALGORITHM = 'EdDSA' as const
const DEFAULT_MAX_LIFETIME_SECONDS = 60
const ALLOWED_ROLE_CLAIMS = ['member'] as const

export type EnvelopePayload = {
  sub: string
  aud: string
  iat: number
  exp: number
  jti: string
  email?: string
  role?: string
}

export type EnvelopeStrategyConfig = {
  /** Injectable so AC-4a's "failed JWKS" failure mode is expressible — return the PEM public
   * key, or throw/reject to simulate an unreachable/failing key endpoint. Defaults to this
   * fixture's own committed test-only public key. */
  getVerificationKey?: () => Promise<string> | string
  /** The audience every valid envelope must carry. Injectable so AC-4a's "wrong audience"
   * failure mode is expressible without touching the signing side. */
  expectedAudience: string
  /** Injectable clock (ms epoch) so AC-4a's "skewed clock" failure mode is expressible.
   * Defaults to the real wall clock. */
  clock?: () => number
  /** Maximum permitted `exp - iat`, in seconds. Envelopes declaring a longer lifetime are
   * rejected regardless of whether they are otherwise valid — this is what makes the
   * "exp - iat > 60s" failure mode independent of plain expiry. */
  maxLifetimeSeconds?: number
}

/**
 * AC-15: the in-memory burned-`jti` store. **This is a single-process `Set` and proves nothing
 * across workers or restarts** — see README.md's warning block. A real implementation MUST use
 * a DB-backed atomic conditional write (`INSERT ... ON CONFLICT DO NOTHING`), exactly like this
 * story's own `native-login-latch.ts` does for its proving latch.
 */
const burnedJti = new Set<string>()

/** Test-only: clears the burned-`jti` store between test cases. Never called from production
 * code (there is no production code path that could reach it — this whole package is a fixture). */
export function __resetBurnedJtiForTests(): void {
  burnedJti.clear()
}

async function defaultGetVerificationKey(): Promise<string> {
  return FIXTURE_TEST_ONLY_PUBLIC_KEY
}

function isAllowedRole(role: unknown): role is (typeof ALLOWED_ROLE_CLAIMS)[number] {
  return typeof role === 'string' && (ALLOWED_ROLE_CLAIMS as readonly string[]).includes(role)
}

/**
 * Story 23.2 AC-15: uniform rejection — every failure mode (bad signature, expired, replayed
 * `jti`, wrong audience, malformed input, `alg: none`, HMAC-confusion, missing claims, untrusted
 * role claim, JWKS-fetch failure) throws the SAME generic error with no distinguishing detail,
 * so a caller cannot use `onAuthenticate()`'s failure as an oracle for which check failed.
 */
class EnvelopeRejectedError extends Error {
  constructor() {
    super('mock-envelope-extension: envelope rejected')
    this.name = 'EnvelopeRejectedError'
  }
}

/**
 * Builds the `AuthStrategy.onAuthenticate()` implementation. Exported (not just the default
 * manifest export) so tests can construct strategies with injected audience/clock/key without
 * loading the whole extension through the real extension loader.
 */
export function createEnvelopeAuthStrategy(config: EnvelopeStrategyConfig): AuthStrategy {
  const getVerificationKey = config.getVerificationKey ?? defaultGetVerificationKey
  const clock = config.clock ?? (() => Date.now())
  const maxLifetimeSeconds = config.maxLifetimeSeconds ?? DEFAULT_MAX_LIFETIME_SECONDS

  return {
    async onAuthenticate(credential: string): Promise<AuthResult> {
      let key: string
      try {
        key = await getVerificationKey()
      } catch {
        // AC-4a: a failing JWKS/key-fetch leaves replacementProven unset, exactly like every
        // other rejection here — never a distinguishable error surfaced to the caller.
        throw new EnvelopeRejectedError()
      }

      const nowMs = clock()
      const verify = createVerifier({
        key,
        // Explicit single-algorithm allowlist — the one thing that prevents both `alg: none`
        // and HMAC-confusion (a forged token whose header claims 'HS256' and whose "signature"
        // is an HMAC computed with this Ed25519 public key's PEM bytes as the secret). fast-jwt
        // never consults the token's own `alg` header to select behavior; `algorithms` is the
        // full allowlist consulted, and there is exactly one entry.
        algorithms: [ALGORITHM],
        allowedAud: config.expectedAudience,
        requiredClaims: ['sub', 'aud', 'iat', 'exp', 'jti'],
        clockTimestamp: nowMs,
      })

      let payload: EnvelopePayload
      try {
        payload = (await verify(credential)) as EnvelopePayload
      } catch {
        throw new EnvelopeRejectedError()
      }

      // fast-jwt validates aud/exp/requiredClaims against the injected clock, but not the
      // envelope's own declared lifetime — a token that is not yet expired but was minted with
      // an absurdly long exp-iat window is a separate risk this fixture deliberately names.
      if (payload.exp - payload.iat > maxLifetimeSeconds) {
        throw new EnvelopeRejectedError()
      }

      // AC-15: never trust a role claim from the envelope beyond a fixed, known-safe set — the
      // envelope proves identity, not authorization.
      if (payload.role !== undefined && !isAllowedRole(payload.role)) {
        throw new EnvelopeRejectedError()
      }

      // AC-15's replay guard. Checked synchronously immediately before the one synchronous
      // `.add()` with no `await` between them, so two concurrent onAuthenticate() calls racing
      // the same jti cannot both observe "not yet burned" — exactly one wins.
      if (burnedJti.has(payload.jti)) {
        throw new EnvelopeRejectedError()
      }
      burnedJti.add(payload.jti)

      return {
        externalSubject: payload.sub,
        providerName: MOCK_ENVELOPE_PROVIDER_NAME,
        email: payload.email,
      }
    },
  }
}

/**
 * Story 23.2 AC-14: signs a fixture envelope with this package's test-only private key — the
 * one and only way tests (and the manual-QA runbook) mint credentials for `onAuthenticate()` to
 * verify. Never used by production code.
 */
export function signFixtureEnvelope(
  claims: {
    sub: string
    aud: string
    email?: string
    role?: string
    jti?: string
  },
  options: {
    privateKey?: string
    algorithm?: string
    lifetimeSeconds?: number
    iatOverride?: number
  } = {}
): string {
  const sign = createSigner({
    key: options.privateKey ?? FIXTURE_TEST_ONLY_PRIVATE_KEY,
    algorithm: (options.algorithm ?? ALGORITHM) as never,
    expiresIn: (options.lifetimeSeconds ?? DEFAULT_MAX_LIFETIME_SECONDS) * 1000,
    jti: claims.jti ?? crypto.randomUUID(),
    aud: claims.aud,
    sub: claims.sub,
    clockTimestamp: options.iatOverride,
  })
  return sign({ email: claims.email, role: claims.role }) as unknown as string
}

const manifest: ExtensionManifest = {
  name: MOCK_ENVELOPE_PROVIDER_NAME,
  apiVersion: '1.2.0',
  capabilities: ['auth-provider'],
  replacesNativeLogin: true,
}

function hooksFactory(): ExtensionHooks {
  // Story 23.2's own AC-14 default wiring: the instance's own base URL/instanceId as the
  // expected audience, matching CentralizeMe's motivating pattern of an audience-scoped
  // envelope. Overridable via env for a manual-QA operator; the default is deliberately narrow
  // (not '*') so a stray envelope minted for a different instance is rejected, not accepted.
  const expectedAudience = process.env['MOCK_ENVELOPE_EXPECTED_AUDIENCE'] ?? 'test-instance'
  return { authStrategy: createEnvelopeAuthStrategy({ expectedAudience }) }
}

export default { manifest, hooksFactory }
