import { env, delegationVerifyKeys } from '../../config/env.js'
import type { DelegationVerifyKey } from '../../config/delegation-verify-keys.js'
import {
  isPlainObject,
  readStringClaim,
  resolveEd25519Key,
  verifyEdDsaJws,
  type JwsCoreReason,
  type VerifyFn,
} from './eddsa-jws-core.js'

/**
 * Story 71.6: verifier for the service-delegated actor assertion (design note
 * service-delegated-actor-assertion-design.md, checks 1-6). A sibling of the handoff verifier on
 * the shared EdDSA-JWS core: its own `typ` (`pv-delegation+jwt`), its own audience namespace
 * (`pvd:<instance id>`), its own key set (`VAULT_DELEGATION_VERIFY_KEYS`), never the handoff set.
 *
 * Pure: no I/O, no logging, no module state, never throws. It does NOT detect replay (the same
 * valid assertion verifies every time; the burn store is Story 71-7), does NOT compare `op`/`bsh`
 * to the real request (Story 71-3) and does NOT create a session or write audit/security events.
 *
 * Forward contract for Story 71-3 and later:
 * - pass ONLY the compact JWS (71-3 parses `Authorization: PV-Delegation <jws>` itself);
 * - `isPreSignatureRejection(reason)` is true for the reasons a caller must collapse into ONE
 *   generic 401 (no oracle for unauthenticated probes); the rest are typed responses;
 * - `claims.org` is the identity-side (CentralizeMe) org id, NOT a PV org id: resolve it through
 *   `organizations.centralizeme_organization_id` before any DB use;
 * - `claims.kid` is returned only on success (a key that matched AND verified), so it is the
 *   only trustworthy rate-limit / `delegatedBy` key; failures carry no kid.
 */

export const DELEGATION_REJECT_REASONS = [
  'delegation_not_configured',
  'delegation_oversized',
  'delegation_malformed',
  'delegation_unexpected_alg',
  'delegation_unknown_kid',
  'delegation_signature_invalid',
  'delegation_malformed_claim',
  'delegation_missing_claim',
  'delegation_expired',
  'delegation_not_yet_valid',
  'delegation_clock_skew',
  'delegation_audience_mismatch',
] as const

export type DelegationRejectReason = (typeof DELEGATION_REJECT_REASONS)[number]

export type DelegationVerifiedClaims = {
  readonly version: 1
  /** A configured key id, safe to log; present only on success. */
  readonly kid: string
  readonly issuer: string
  readonly audience: string
  readonly issuedAt: number
  readonly expiresAt: number
  readonly jti: string
  /** Identity-side org id, NOT a PV org id (see the module header). */
  readonly org: string
  readonly actor: { readonly provider: string; readonly subject: string }
  readonly operation: string
  readonly bodyHash: string
  /**
   * Story 71.4: the issuer-signed occurrence time (`occ`, epoch SECONDS), present only when the
   * assertion carried one. It proves only that the issuer says so; PV cannot verify occurrence.
   */
  readonly occurredAt?: number
}

export type DelegationVerifyResult =
  | { readonly ok: true; readonly claims: DelegationVerifiedClaims }
  | { readonly ok: false; readonly reason: DelegationRejectReason }

export type DelegationVerifierDeps = {
  now?: () => number
  keys?: readonly DelegationVerifyKey[]
  instanceId?: string
  issuer?: string
  verifyFn?: VerifyFn
}

const MAX_ASSERTION_BYTES = 8 * 1024
const MAX_KID_LENGTH = 128
const MAX_STRING_CLAIM_BYTES = 256
const MAX_ID_CLAIM_BYTES = 128
const CLOCK_SKEW_TOLERANCE_SECONDS = 30
const MAX_LIFETIME_SECONDS = 60
/** Story 71.4: `occ` may not be later than `iat` plus this (the same bound as the clock skew). */
const MAX_OCCURRENCE_AHEAD_OF_ISSUE_SECONDS = 30
const BODY_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/

const PRE_SIGNATURE: ReadonlySet<DelegationRejectReason> = new Set([
  'delegation_not_configured',
  'delegation_oversized',
  'delegation_malformed',
  'delegation_unexpected_alg',
  'delegation_unknown_kid',
  'delegation_signature_invalid',
])

/** True for the reasons that must collapse into one generic 401 (design check 1-3, threat 13). */
export function isPreSignatureRejection(reason: DelegationRejectReason): boolean {
  return PRE_SIGNATURE.has(reason)
}

/**
 * Counter outcomes (design section 7) for each reason. `delegation_missing_claim` folds into
 * `malformed_claim` for the counter, so metric cardinality stays bounded and kid/jti/org free.
 */
export const DELEGATION_REASON_TO_OUTCOME: Readonly<Record<DelegationRejectReason, string>> =
  Object.freeze({
    delegation_not_configured: 'not_configured',
    delegation_oversized: 'oversized',
    delegation_malformed: 'malformed',
    delegation_unexpected_alg: 'unexpected_alg',
    delegation_unknown_kid: 'unknown_kid',
    delegation_signature_invalid: 'signature_invalid',
    delegation_malformed_claim: 'malformed_claim',
    delegation_missing_claim: 'malformed_claim',
    delegation_expired: 'expired',
    delegation_not_yet_valid: 'not_yet_valid',
    delegation_clock_skew: 'clock_skew',
    delegation_audience_mismatch: 'audience_mismatch',
  })

/**
 * Story 71.3 AC-8: the counter outcomes that do not come from a verifier reason, decided by the
 * host pipeline after (or instead of) verification. Kept next to `DELEGATION_REASON_TO_OUTCOME` so
 * the closed `pv_delegation_assertions_total{outcome}` set lives in exactly one place.
 * `unsupported_encoding` is the one outcome beyond the 71-2 design table (the 71-3 `Content-Encoding`
 * rejection, AC-4); `actor_unlinked` and `actor_attested_nonmember` count admitted requests.
 */
export const DELEGATION_HOST_OUTCOMES = [
  'missing',
  'rate_limited_pre',
  'operation_mismatch',
  'unsupported_encoding',
  'body_mismatch',
  'subject_mismatch',
  'occurrence_outside_window',
  'org_not_served',
  'replayed',
  'store_unavailable',
  'actor_not_member',
  'actor_unlinked',
  'actor_attested_nonmember',
] as const

export type DelegationHostOutcome = (typeof DELEGATION_HOST_OUTCOMES)[number]

/** Every value of the `outcome` label, verifier-derived and host-derived. */
export const DELEGATION_OUTCOMES: readonly string[] = Object.freeze([
  ...new Set(Object.values(DELEGATION_REASON_TO_OUTCOME)),
  ...DELEGATION_HOST_OUTCOMES,
])

const CORE_REASON: Record<JwsCoreReason, DelegationRejectReason> = {
  oversized: 'delegation_oversized',
  malformed: 'delegation_malformed',
  unexpected_alg: 'delegation_unexpected_alg',
  unknown_kid: 'delegation_unknown_kid',
  signature_invalid: 'delegation_signature_invalid',
}

type Check<T> = { ok: true; value: T } | { ok: false; reason: DelegationRejectReason }

function fail(reason: DelegationRejectReason): { ok: false; reason: DelegationRejectReason } {
  return Object.freeze({ ok: false as const, reason })
}

function str(payload: Record<string, unknown>, key: string, maxBytes: number): Check<string> {
  const result = readStringClaim(payload, key, maxBytes)
  if (result.ok) return result
  return fail(result.kind === 'missing' ? 'delegation_missing_claim' : 'delegation_malformed_claim')
}

function checkVersion(payload: Record<string, unknown>): DelegationRejectReason | undefined {
  const ver = payload['ver']
  if (isAbsent(ver)) return 'delegation_missing_claim'
  return ver === 1 ? undefined : 'delegation_malformed_claim'
}

function checkActor(
  payload: Record<string, unknown>
): Check<{ provider: string; subject: string }> {
  const act = payload['act']
  if (isAbsent(act)) return fail('delegation_missing_claim')
  if (!isPlainObject(act)) return fail('delegation_malformed_claim')
  const provider = str(act, 'prv', MAX_STRING_CLAIM_BYTES)
  if (!provider.ok) return provider
  const subject = str(act, 'sub', MAX_STRING_CLAIM_BYTES)
  if (!subject.ok) return subject
  return { ok: true, value: { provider: provider.value, subject: subject.value } }
}

function checkBodyHash(payload: Record<string, unknown>): Check<string> {
  const bsh = str(payload, 'bsh', MAX_STRING_CLAIM_BYTES)
  if (!bsh.ok) return bsh
  return BODY_HASH_PATTERN.test(bsh.value) ? bsh : fail('delegation_malformed_claim')
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null
}

function checkTimes(payload: Record<string, unknown>): Check<{ iat: number; exp: number }> {
  const iat = payload['iat']
  const exp = payload['exp']
  if (isAbsent(iat) || isAbsent(exp)) return fail('delegation_missing_claim')
  if (!isFiniteNumber(iat) || !isFiniteNumber(exp)) return fail('delegation_malformed_claim')
  const lifetime = exp - iat
  if (lifetime <= 0 || lifetime > MAX_LIFETIME_SECONDS) return fail('delegation_malformed_claim')
  return { ok: true, value: { iat, exp } }
}

/**
 * Story 71.4 AC-2: an optional signed `occ`. Absent or `null` = not signed. Present = a positive
 * safe integer not later than `iat + 30`; anything else is a malformed claim (post-signature).
 * Own properties only (DW-513 item 3).
 */
function checkOccurrence(payload: Record<string, unknown>, iat: number): Check<number | undefined> {
  const occ: unknown = Object.hasOwn(payload, 'occ') ? Reflect.get(payload, 'occ') : undefined
  if (isAbsent(occ)) return { ok: true, value: undefined }
  if (typeof occ !== 'number' || !Number.isSafeInteger(occ) || occ <= 0) {
    return fail('delegation_malformed_claim')
  }
  if (occ > iat + MAX_OCCURRENCE_AHEAD_OF_ISSUE_SECONDS) return fail('delegation_malformed_claim')
  return { ok: true, value: occ }
}

function checkWindow(
  iat: number,
  exp: number,
  nowSeconds: number
): DelegationRejectReason | undefined {
  if (iat > nowSeconds + CLOCK_SKEW_TOLERANCE_SECONDS) return 'delegation_clock_skew'
  if (exp + CLOCK_SKEW_TOLERANCE_SECONDS < nowSeconds) return 'delegation_expired'
  return undefined
}

type Scalars = {
  issuer: string
  audience: string
  jti: string
  org: string
}

function checkScalars(payload: Record<string, unknown>, issuerExpected: string): Check<Scalars> {
  const issuer = str(payload, 'iss', MAX_STRING_CLAIM_BYTES)
  if (!issuer.ok) return issuer
  if (issuer.value !== issuerExpected) return fail('delegation_malformed_claim')
  const audience = str(payload, 'aud', MAX_STRING_CLAIM_BYTES)
  if (!audience.ok) return audience
  const jti = str(payload, 'jti', MAX_ID_CLAIM_BYTES)
  if (!jti.ok) return jti
  const org = str(payload, 'org', MAX_ID_CLAIM_BYTES)
  if (!org.ok) return org
  return {
    ok: true,
    value: { issuer: issuer.value, audience: audience.value, jti: jti.value, org: org.value },
  }
}

type Shape = Scalars & {
  operation: string
  actor: { provider: string; subject: string }
  bodyHash: string
  iat: number
  exp: number
  occ: number | undefined
}

/** Shape, bounds, `ver` and `iss` checks in design order; time and audience come after. */
function checkShape(payload: Record<string, unknown>, issuer: string): Check<Shape> {
  const versionIssue = checkVersion(payload)
  if (versionIssue) return fail(versionIssue)
  const scalars = checkScalars(payload, issuer)
  if (!scalars.ok) return scalars
  const actor = checkActor(payload)
  if (!actor.ok) return actor
  const operation = str(payload, 'op', MAX_STRING_CLAIM_BYTES)
  if (!operation.ok) return operation
  const bodyHash = checkBodyHash(payload)
  if (!bodyHash.ok) return bodyHash
  const times = checkTimes(payload)
  if (!times.ok) return times
  const occurrence = checkOccurrence(payload, times.value.iat)
  if (!occurrence.ok) return occurrence
  return {
    ok: true,
    value: {
      ...scalars.value,
      operation: operation.value,
      actor: actor.value,
      bodyHash: bodyHash.value,
      iat: times.value.iat,
      exp: times.value.exp,
      occ: occurrence.value,
    },
  }
}

function freezeClaims(kid: string, shape: Shape): DelegationVerifyResult {
  const claims: DelegationVerifiedClaims = Object.freeze({
    version: 1 as const,
    kid,
    issuer: shape.issuer,
    audience: shape.audience,
    issuedAt: shape.iat,
    expiresAt: shape.exp,
    jti: shape.jti,
    org: shape.org,
    actor: Object.freeze({ provider: shape.actor.provider, subject: shape.actor.subject }),
    operation: shape.operation,
    bodyHash: shape.bodyHash,
    ...(shape.occ === undefined ? {} : { occurredAt: shape.occ }),
  })
  return Object.freeze({ ok: true as const, claims })
}

/**
 * Builds a verifier. Dependencies are injected (clock, key set, instance id, issuer, verify
 * function) so tests need no module mocking and production callers of the exported
 * `verifyDelegationAssertion` cannot influence time or keys.
 */
export function createDelegationVerifier(
  deps: DelegationVerifierDeps = {}
): (token: unknown) => DelegationVerifyResult {
  const now = deps.now ?? Date.now
  const keys = deps.keys ?? delegationVerifyKeys
  const instanceId = 'instanceId' in deps ? deps.instanceId : env.VAULT_HANDOFF_INSTANCE_ID
  const issuer = deps.issuer ?? env.VAULT_HANDOFF_ISSUER

  return (token: unknown): DelegationVerifyResult => {
    if (keys.length === 0 || !instanceId) return fail('delegation_not_configured')

    const jws = verifyEdDsaJws(token, {
      expectedTyp: 'pv-delegation+jwt',
      maxTokenBytes: MAX_ASSERTION_BYTES,
      maxKidLength: MAX_KID_LENGTH,
      resolveKey: (kid) => resolveEd25519Key(keys, kid),
      verifyFn: deps.verifyFn,
    })
    if (!jws.ok) return fail(CORE_REASON[jws.reason])
    if (!isPlainObject(jws.payload)) return fail('delegation_malformed')

    const shape = checkShape(jws.payload, issuer)
    if (!shape.ok) return fail(shape.reason)
    const windowIssue = checkWindow(shape.value.iat, shape.value.exp, now() / 1000)
    if (windowIssue) return fail(windowIssue)
    if (shape.value.audience !== `pvd:${instanceId}`) return fail('delegation_audience_mismatch')
    return freezeClaims(jws.kid, shape.value)
  }
}

/** The production verifier: real clock, live key set, live instance identity and issuer. */
export function verifyDelegationAssertion(token: unknown): DelegationVerifyResult {
  return createDelegationVerifier()(token)
}
