import { createPublicKey } from 'node:crypto'
import {
  type VerifyKeySetParseError,
  parseVerifyKeySet,
  type VerifyKeySetEntry,
} from './verify-key-set.js'

// Story 71.6 AC-4: the delegation verification key set (VAULT_DELEGATION_VERIFY_KEYS). Stricter
// than the handoff set at boot: Ed25519 only, exactly one PEM block, and kept disjoint from the
// handoff set by kid AND by key material. Messages carry the variable name and, where useful, a
// configured `kid`; they never carry PEM text or the raw value.

export type DelegationVerifyKey = VerifyKeySetEntry

export class DelegationVerifyKeysError extends Error {}

const VAR = 'VAULT_DELEGATION_VERIFY_KEYS'
const HANDOFF_VAR = 'VAULT_HANDOFF_VERIFY_KEYS'
const SINGLE_BLOCK = /^-----BEGIN PUBLIC KEY-----[A-Za-z0-9+/=\r\n]+-----END PUBLIC KEY-----$/
const PEM_MESSAGE = 'publicKeyPem must be an Ed25519 PUBLIC key in exactly one PEM block'

function notEd25519(kid: string): DelegationVerifyKeysError {
  return new DelegationVerifyKeysError(
    `${VAR} kid "${kid}": publicKeyPem must be an Ed25519 PUBLIC key in exactly one PEM block`
  )
}

/** SPKI DER bytes of an Ed25519 public key, or undefined when it is not one. */
function spkiOf(pem: string): Buffer | undefined {
  try {
    const key = createPublicKey({ key: pem, format: 'pem' })
    if (key.asymmetricKeyType !== 'ed25519') return undefined
    return key.export({ type: 'spki', format: 'der' })
  } catch {
    return undefined
  }
}

function parseShape(raw: string | undefined): VerifyKeySetEntry[] {
  try {
    return parseVerifyKeySet(raw, VAR, PEM_MESSAGE)
  } catch (err) {
    // parseVerifyKeySet only ever throws VerifyKeySetParseError.
    throw new DelegationVerifyKeysError((err as VerifyKeySetParseError).message)
  }
}

/**
 * Parses and validates the delegation set. Throws DelegationVerifyKeysError on any problem. The
 * returned list and its entries are frozen: the live key set cannot be mutated by a consumer.
 */
export function parseDelegationVerifyKeys(raw: string | undefined): readonly DelegationVerifyKey[] {
  const entries = parseShape(raw)
  for (const entry of entries) {
    if (!SINGLE_BLOCK.test(entry.publicKeyPem.trim()) || !spkiOf(entry.publicKeyPem)) {
      throw notEd25519(entry.kid)
    }
  }
  return Object.freeze(entries.map((entry) => Object.freeze({ ...entry })))
}

function disjointnessProblem(
  delegation: readonly DelegationVerifyKey[],
  handoffRaw: string | undefined
): string | undefined {
  let handoff: VerifyKeySetEntry[]
  try {
    handoff = parseVerifyKeySet(handoffRaw, HANDOFF_VAR)
  } catch {
    // One root cause: the handoff validator already reports its own malformed set.
    return undefined
  }
  const handoffByKid = new Map(handoff.map((h) => [h.kid, h]))
  const handoffKeys = handoff.map((h) => ({ kid: h.kid, spki: spkiOf(h.publicKeyPem) }))
  for (const entry of delegation) {
    if (handoffByKid.has(entry.kid)) {
      return `${VAR} kid "${entry.kid}" also appears in ${HANDOFF_VAR}; the two key sets must be disjoint`
    }
    const spki = spkiOf(entry.publicKeyPem)
    const clash = handoffKeys.find((h) => h.spki && spki && h.spki.equals(spki))
    if (clash) {
      return `${VAR} kid "${entry.kid}" reuses the public key of ${HANDOFF_VAR} kid "${clash.kid}"; the two key sets must be disjoint`
    }
  }
  return undefined
}

/** Boot validation: returns the (at most one) problem message; an empty list means valid. */
export function validateDelegationVerifyKeys(
  raw: string | undefined,
  handoffRaw: string | undefined,
  instanceId: string | undefined
): string[] {
  let keys: readonly DelegationVerifyKey[]
  try {
    keys = parseDelegationVerifyKeys(raw)
  } catch (err) {
    return [(err as DelegationVerifyKeysError).message]
  }
  if (keys.length === 0) return []
  if (!instanceId) {
    return [
      `${VAR} requires VAULT_HANDOFF_INSTANCE_ID (the assertion audience is pvd:<instance id>)`,
    ]
  }
  const problem = disjointnessProblem(keys, handoffRaw)
  return problem ? [problem] : []
}
