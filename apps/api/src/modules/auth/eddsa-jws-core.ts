import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto'

/** The Ed25519 `crypto.verify` call shape (algorithm null); the seam tests inject. */
export type VerifyFn = (algorithm: null, data: Buffer, key: KeyObject, signature: Buffer) => boolean

/**
 * Story 71.6 D1/D2: the shared EdDSA (Ed25519) compact-JWS core used by BOTH the handoff login
 * verifier and the delegation-assertion verifier. It owns the mechanics that must never differ
 * between them: size cap, 3-part split, header checks in a fixed order (`typ`, `enc`, pinned
 * `alg`, `kid` bounds), exact-`kid` key selection (never "try every key"), the signature check
 * over the ORIGINAL `header.payload` text, and the payload decode (after the signature).
 *
 * The core is pure: it never imports `env` or a key set (the caller injects `resolveKey`), never
 * logs, and never throws for any input. Callers map the neutral reasons below to their own codes.
 */

export type JwsCoreReason =
  'oversized' | 'malformed' | 'unexpected_alg' | 'unknown_kid' | 'signature_invalid'

export type JwsProfile = {
  expectedTyp: string
  maxTokenBytes: number
  maxKidLength: number
  /** Exact-kid resolver returning an Ed25519 public key, or undefined. */
  resolveKey: (kid: string) => KeyObject | undefined
  /** Test seam (Story 71.6 D7): defaults to `crypto.verify`. */
  verifyFn?: VerifyFn
}

export type JwsCoreResult =
  { ok: true; kid: string; payload: unknown } | { ok: false; reason: JwsCoreReason }

export function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Buffer.from never throws for a string input and silently skips invalid characters; strictness
// comes from signature verification over the original text, not from decode errors.
export function base64UrlDecode(segment: string): Buffer {
  return Buffer.from(segment, 'base64url')
}

// `unknown` already admits `undefined`, so the failure case needs no separate union member.
export function parseJson(buf: Buffer): unknown {
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * Reads a required string claim. `undefined`/`null` is `missing`; a wrong type, an empty string or
 * a value over `maxBytes` UTF-8 bytes is `malformed`.
 */
export function readStringClaim(
  payload: Record<string, unknown>,
  key: string,
  maxBytes: number
): { ok: true; value: string } | { ok: false; kind: 'missing' | 'malformed' } {
  // Own properties only: a prototype-chain name can never satisfy a claim.
  const value: unknown = Object.hasOwn(payload, key) ? Reflect.get(payload, key) : undefined
  if (value === undefined || value === null) return { ok: false, kind: 'missing' }
  if (typeof value !== 'string' || value.length === 0 || byteLength(value) > maxBytes) {
    return { ok: false, kind: 'malformed' }
  }
  return { ok: true, value }
}

/**
 * Resolves the Ed25519 public key for `kid` out of `keys`: exact string equality on an array
 * (never a property lookup, so `__proto__`/`constructor` kids cannot match), no scan-and-try.
 */
export function resolveEd25519Key(
  keys: readonly { kid: string; publicKeyPem: string }[],
  kid: string
): KeyObject | undefined {
  const entry = keys.find((k) => k.kid === kid)
  if (!entry) return undefined
  try {
    const keyObject = createPublicKey({ key: entry.publicKeyPem, format: 'pem' })
    return keyObject.asymmetricKeyType === 'ed25519' ? keyObject : undefined
  } catch {
    return undefined
  }
}

function parseHeader(part: string): Record<string, unknown> | undefined {
  const parsed = parseJson(base64UrlDecode(part))
  return isPlainObject(parsed) ? parsed : undefined
}

type HeaderCheck = { ok: true; kid: string } | { ok: false; reason: JwsCoreReason }

/** Header checks in the contract order: typ -> enc -> alg -> kid bounds. */
function checkHeader(headerPart: string, profile: JwsProfile): HeaderCheck {
  const header = parseHeader(headerPart)
  if (!header) return { ok: false, reason: 'malformed' }
  if (header['typ'] !== profile.expectedTyp) return { ok: false, reason: 'malformed' }
  if (header['enc'] !== undefined) return { ok: false, reason: 'malformed' }
  if (header['alg'] !== 'EdDSA') return { ok: false, reason: 'unexpected_alg' }
  const kid = header['kid']
  if (typeof kid !== 'string' || kid.length < 1 || kid.length > profile.maxKidLength) {
    return { ok: false, reason: 'unknown_kid' }
  }
  return { ok: true, kid }
}

function verifySignature(
  signingInput: string,
  signaturePart: string,
  key: KeyObject,
  verifyFn: VerifyFn
): boolean {
  try {
    return verifyFn(null, Buffer.from(signingInput, 'utf8'), key, base64UrlDecode(signaturePart))
  } catch {
    return false
  }
}

/** Verifies a compact EdDSA JWS against `profile`. Never throws. */
export function verifyEdDsaJws(token: unknown, profile: JwsProfile): JwsCoreResult {
  if (typeof token !== 'string' || byteLength(token) > profile.maxTokenBytes) {
    return { ok: false, reason: 'oversized' }
  }
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, reason: 'malformed' }
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string]

  const header = checkHeader(headerPart, profile)
  if (!header.ok) return header

  // Exactly one key is selected by kid match; an unknown kid never falls back to another key.
  const key = profile.resolveKey(header.kid)
  if (!key) return { ok: false, reason: 'unknown_kid' }

  const verifyFn = profile.verifyFn ?? cryptoVerify
  if (!verifySignature(`${headerPart}.${payloadPart}`, signaturePart, key, verifyFn)) {
    return { ok: false, reason: 'signature_invalid' }
  }

  const payload = parseJson(base64UrlDecode(payloadPart))
  // JSON `null` is a valid parse; only a parse failure (undefined) is malformed here. Callers
  // reject any non-object payload themselves.
  if (payload === undefined) return { ok: false, reason: 'malformed' }
  return { ok: true, kid: header.kid, payload }
}
