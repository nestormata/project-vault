import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto'
import { env, handoffVerifyKeys } from '../../config/env.js'

/**
 * Story 30.2 Task 4: the EdDSA compact-JWS verifier for CentralizeMe-issued handoff tokens.
 * Implements the claim contract's rejection-matrix rows 1-6 (structural/signature/time/audience)
 * in the exact order the contract requires — pin `alg` -> select key by `kid` (never iterate
 * every configured key) -> verify signature -> structural/type/bounds checks -> time checks ->
 * audience/instance checks. Rows 7+ (JTI burn, org cross-check, membership/MFA) live in
 * handoff-routes.ts, which needs a real DB transaction this module deliberately has none of.
 *
 * Hand-rolled against Node's `crypto` module (rather than fast-jwt) so every rejection branch and
 * the "select exactly one key by kid or reject outright" invariant (AC3.10) is directly
 * inspectable and testable, with no library-internal algorithm-negotiation behavior to audit.
 */

export type HandoffRejectReason =
  | 'handoff_malformed_claim'
  | 'handoff_claims_oversized'
  | 'handoff_unexpected_alg'
  | 'handoff_unknown_kid'
  | 'handoff_signature_invalid'
  | 'handoff_missing_claim'
  | 'handoff_clock_skew'
  | 'handoff_not_yet_valid'
  | 'handoff_expired'
  | 'handoff_audience_mismatch'
  | 'handoff_unknown_assurance'

export type HandoffVerifiedClaims = {
  jti: string
  workosUserId: string
  providerName: string
  organizationId: string
  instanceId: string
  tier: string
  capabilities: string[]
  quotas: Record<string, number> | undefined
  claimsVersion: number
  amr: string[] | undefined
  /** AC4.17: claimsVersion !== 1 — identity/session claims still apply, but any
   *  capability/tier/quota claim must be treated by callers as a non-grant. */
  unknownClaimsVersion: boolean
}

export type HandoffVerifyResult =
  { ok: true; claims: HandoffVerifiedClaims } | { ok: false; reason: HandoffRejectReason }

// Claim contract "Ingestion abuse and transport" section: compact JWS body cap.
export const MAX_HANDOFF_TOKEN_BYTES = 16 * 1024
const MAX_CAPABILITIES_PAYLOAD_BYTES = 8 * 1024
const MAX_CAPABILITIES_COUNT = 64
const MAX_KID_LENGTH = 128
const MAX_STRING_CLAIM_BYTES = 256
const CLOCK_SKEW_TOLERANCE_SECONDS = 30
const MAX_TOKEN_LIFETIME_SECONDS = 60
const ALLOWED_AMR_VALUES = new Set(['pwd', 'otp', 'mfa', 'webauthn', 'sso'])

function reject(reason: HandoffRejectReason): HandoffVerifyResult {
  return { ok: false, reason }
}

function base64UrlDecode(segment: string): Buffer | undefined {
  try {
    return Buffer.from(segment, 'base64url')
  } catch {
    return undefined
  }
}

function parseJson(buf: Buffer): unknown | undefined {
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    return undefined
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

type Header = { alg: unknown; kid: unknown; typ: unknown; enc?: unknown }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseHeader(part: string): Header | undefined {
  const raw = base64UrlDecode(part)
  if (!raw) return undefined
  const parsed = parseJson(raw)
  if (!isPlainObject(parsed)) return undefined
  return parsed as unknown as Header
}

/** Resolves the EdDSA (Ed25519) public key for `kid` — exact match only, never a scan-and-try. */
function resolveKey(kid: string): KeyObject | undefined {
  const entry = handoffVerifyKeys.find((k) => k.kid === kid)
  if (!entry) return undefined
  try {
    const keyObject = createPublicKey({ key: entry.publicKeyPem, format: 'pem' })
    if (keyObject.asymmetricKeyType !== 'ed25519') return undefined
    return keyObject
  } catch {
    return undefined
  }
}

function verifySignature(signingInput: string, signaturePart: string, key: KeyObject): boolean {
  const signature = base64UrlDecode(signaturePart)
  if (!signature) return false
  try {
    return cryptoVerify(null, Buffer.from(signingInput, 'utf8'), key, signature)
  } catch {
    return false
  }
}

type PayloadValidation =
  { ok: true; claims: HandoffVerifiedClaims } | { ok: false; reason: HandoffRejectReason }

function requireString(
  payload: Record<string, unknown>,
  key: string,
  maxBytes = MAX_STRING_CLAIM_BYTES
): { ok: true; value: string } | { ok: false; reason: HandoffRejectReason } {
  const value = payload[key]
  if (value === undefined || value === null) return { ok: false, reason: 'handoff_missing_claim' }
  if (typeof value !== 'string' || value.length === 0 || byteLength(value) > maxBytes) {
    return { ok: false, reason: 'handoff_malformed_claim' }
  }
  return { ok: true, value }
}

function validateCapabilities(
  payload: Record<string, unknown>
): { ok: true; value: string[] } | { ok: false; reason: HandoffRejectReason } {
  const raw = payload['capabilities']
  if (raw === undefined) return { ok: false, reason: 'handoff_missing_claim' }
  if (!Array.isArray(raw) || raw.length > MAX_CAPABILITIES_COUNT) {
    return { ok: false, reason: 'handoff_malformed_claim' }
  }
  let totalBytes = 0
  for (const item of raw) {
    if (typeof item !== 'string' || byteLength(item) > MAX_STRING_CLAIM_BYTES) {
      return { ok: false, reason: 'handoff_malformed_claim' }
    }
    totalBytes += byteLength(item)
  }
  if (totalBytes > MAX_CAPABILITIES_PAYLOAD_BYTES)
    return { ok: false, reason: 'handoff_claims_oversized' }
  return { ok: true, value: raw as string[] }
}

function validateQuotas(
  payload: Record<string, unknown>
):
  | { ok: true; value: Record<string, number> | undefined }
  | { ok: false; reason: HandoffRejectReason } {
  const raw = payload['quotas']
  if (raw === undefined) return { ok: true, value: undefined }
  if (!isPlainObject(raw)) return { ok: false, reason: 'handoff_malformed_claim' }
  const entries = Object.entries(raw)
  if (entries.length > MAX_CAPABILITIES_COUNT)
    return { ok: false, reason: 'handoff_malformed_claim' }
  for (const [, value] of entries) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return { ok: false, reason: 'handoff_malformed_claim' }
    }
  }
  return { ok: true, value: raw as Record<string, number> }
}

function validateAmr(
  payload: Record<string, unknown>
): { ok: true; value: string[] | undefined } | { ok: false; reason: HandoffRejectReason } {
  const raw = payload['amr']
  if (raw === undefined) return { ok: true, value: undefined }
  if (!Array.isArray(raw) || raw.length > 8) return { ok: false, reason: 'handoff_malformed_claim' }
  for (const item of raw) {
    if (typeof item !== 'string') return { ok: false, reason: 'handoff_malformed_claim' }
    if (!ALLOWED_AMR_VALUES.has(item)) return { ok: false, reason: 'handoff_unknown_assurance' }
  }
  return { ok: true, value: raw as string[] }
}

/** Split out of `validateTimeClaims` to keep it under the repo's complexity threshold. */
function checkFiniteTimeClaims(iat: number, nbf: number | undefined, exp: number): boolean {
  if (!Number.isFinite(iat) || !Number.isFinite(exp)) return false
  if (nbf !== undefined && !Number.isFinite(nbf)) return false
  return true
}

function validateTimeClaims(
  iat: number,
  nbf: number | undefined,
  exp: number
): HandoffRejectReason | undefined {
  if (!checkFiniteTimeClaims(iat, nbf, exp)) return 'handoff_malformed_claim'
  const lifetime = exp - iat
  if (lifetime <= 0 || lifetime > MAX_TOKEN_LIFETIME_SECONDS) return 'handoff_malformed_claim'

  const nowSeconds = Date.now() / 1000
  if (iat > nowSeconds + CLOCK_SKEW_TOLERANCE_SECONDS) return 'handoff_clock_skew'
  const effectiveNbf = nbf ?? iat
  if (effectiveNbf > nowSeconds + CLOCK_SKEW_TOLERANCE_SECONDS) return 'handoff_not_yet_valid'
  if (exp + CLOCK_SKEW_TOLERANCE_SECONDS < nowSeconds) return 'handoff_expired'
  return undefined
}

type RequiredStrings = {
  iss: string
  aud: string
  workosUserId: string
  providerName: string
  organizationId: string
  instanceId: string
  tier: string
  jti: string
}

/** Split out of `validatePayload` to keep it under the repo's complexity threshold. */
function validateRequiredStrings(
  payload: Record<string, unknown>
): { ok: true; value: RequiredStrings } | { ok: false; reason: HandoffRejectReason } {
  const iss = requireString(payload, 'iss')
  if (!iss.ok) return iss
  if (iss.value !== env.VAULT_HANDOFF_ISSUER)
    return { ok: false, reason: 'handoff_malformed_claim' }

  const aud = requireString(payload, 'aud')
  if (!aud.ok) return aud
  const workosUserId = requireString(payload, 'workosUserId')
  if (!workosUserId.ok) return workosUserId
  const providerName = requireString(payload, 'providerName')
  if (!providerName.ok) return providerName
  const organizationId = requireString(payload, 'organizationId', MAX_KID_LENGTH)
  if (!organizationId.ok) return organizationId
  const instanceId = requireString(payload, 'instanceId')
  if (!instanceId.ok) return instanceId
  const tier = requireString(payload, 'tier', MAX_KID_LENGTH)
  if (!tier.ok) return tier
  const jti = requireString(payload, 'jti', MAX_KID_LENGTH)
  if (!jti.ok) return jti

  return {
    ok: true,
    value: {
      iss: iss.value,
      aud: aud.value,
      workosUserId: workosUserId.value,
      providerName: providerName.value,
      organizationId: organizationId.value,
      instanceId: instanceId.value,
      tier: tier.value,
      jti: jti.value,
    },
  }
}

/** Split out of `validatePayload` to keep it under the repo's complexity threshold. */
function validateClaimsVersion(
  payload: Record<string, unknown>
): { ok: true; value: number } | { ok: false; reason: HandoffRejectReason } {
  const raw = payload['claimsVersion']
  if (raw === undefined) return { ok: false, reason: 'handoff_missing_claim' }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    return { ok: false, reason: 'handoff_malformed_claim' }
  }
  return { ok: true, value: raw }
}

/** Split out of `validatePayload` to keep it under the repo's complexity threshold: extracts
 *  iat/nbf/exp, type-checks them, then delegates to `validateTimeClaims` for the tolerance math. */
function validateTimeFields(payload: Record<string, unknown>): HandoffRejectReason | undefined {
  const iat = payload['iat']
  const exp = payload['exp']
  const nbf = payload['nbf']
  if (iat === undefined || exp === undefined) return 'handoff_missing_claim'
  if (typeof iat !== 'number' || typeof exp !== 'number') return 'handoff_malformed_claim'
  if (nbf !== undefined && typeof nbf !== 'number') return 'handoff_malformed_claim'
  return validateTimeClaims(iat, nbf as number | undefined, exp)
}

/** Split out of `validatePayload` to keep it under the repo's complexity threshold. */
function validateAudience(aud: string, instanceId: string): HandoffRejectReason | undefined {
  // AC3/rejection-matrix row 6: exact audience/instance binding — pv:<instanceId> AND the
  // discrete instanceId claim must both match this instance's configured identity.
  if (
    aud !== `pv:${env.VAULT_HANDOFF_INSTANCE_ID}` ||
    instanceId !== env.VAULT_HANDOFF_INSTANCE_ID
  ) {
    return 'handoff_audience_mismatch'
  }
  return undefined
}

function validatePayload(payload: unknown): PayloadValidation {
  if (!isPlainObject(payload)) return { ok: false, reason: 'handoff_malformed_claim' }

  const strings = validateRequiredStrings(payload)
  if (!strings.ok) return strings

  const capabilities = validateCapabilities(payload)
  if (!capabilities.ok) return capabilities
  const quotas = validateQuotas(payload)
  if (!quotas.ok) return quotas
  const amr = validateAmr(payload)
  if (!amr.ok) return amr
  const claimsVersion = validateClaimsVersion(payload)
  if (!claimsVersion.ok) return claimsVersion

  const timeIssue = validateTimeFields(payload)
  if (timeIssue) return { ok: false, reason: timeIssue }

  const audienceIssue = validateAudience(strings.value.aud, strings.value.instanceId)
  if (audienceIssue) return { ok: false, reason: audienceIssue }

  return {
    ok: true,
    claims: {
      jti: strings.value.jti,
      workosUserId: strings.value.workosUserId,
      providerName: strings.value.providerName,
      organizationId: strings.value.organizationId,
      instanceId: strings.value.instanceId,
      tier: strings.value.tier,
      capabilities: capabilities.value,
      quotas: quotas.value,
      claimsVersion: claimsVersion.value,
      amr: amr.value,
      unknownClaimsVersion: claimsVersion.value !== 1,
    },
  }
}

type HeaderCheckResult = { ok: true; kid: string } | { ok: false; reason: HandoffRejectReason }

/**
 * Structural header checks (typ/enc/alg) plus kid selection, in rejection-matrix order. Split out
 * of `verifyHandoffToken` to keep it under the repo's complexity threshold.
 */
function checkHeader(headerPart: string): HeaderCheckResult {
  const header = parseHeader(headerPart)
  if (!header) return { ok: false, reason: 'handoff_malformed_claim' }
  if (header.typ !== 'JWT') return { ok: false, reason: 'handoff_malformed_claim' }
  if (header.enc !== undefined) return { ok: false, reason: 'handoff_malformed_claim' }
  if (header.alg !== 'EdDSA') return { ok: false, reason: 'handoff_unexpected_alg' }
  if (
    typeof header.kid !== 'string' ||
    header.kid.length < 1 ||
    header.kid.length > MAX_KID_LENGTH
  ) {
    return { ok: false, reason: 'handoff_unknown_kid' }
  }
  return { ok: true, kid: header.kid }
}

/**
 * Verifies a compact-JWS handoff token end to end (rejection-matrix rows 1-6). Never throws —
 * every failure mode resolves to `{ ok: false, reason }`.
 */
export function verifyHandoffToken(token: string): HandoffVerifyResult {
  if (typeof token !== 'string' || byteLength(token) > MAX_HANDOFF_TOKEN_BYTES) {
    return reject('handoff_claims_oversized')
  }

  const parts = token.split('.')
  if (parts.length !== 3) return reject('handoff_malformed_claim')
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]

  const headerCheck = checkHeader(headerPart)
  if (!headerCheck.ok) return reject(headerCheck.reason)

  // AC3.10: exactly one key is selected by kid match — never "try every configured key".
  const key = resolveKey(headerCheck.kid)
  if (!key) return reject('handoff_unknown_kid')

  const signingInput = `${headerPart}.${payloadPart}`
  if (!verifySignature(signingInput, signaturePart, key)) {
    return reject('handoff_signature_invalid')
  }

  const payloadRaw = base64UrlDecode(payloadPart)
  if (!payloadRaw) return reject('handoff_malformed_claim')
  const payload = parseJson(payloadRaw)
  const validated = validatePayload(payload)
  if (!validated.ok) return reject(validated.reason)
  return { ok: true, claims: validated.claims }
}
