// Story 30.1 / 71.6: the single, shared shape parser for the JSON key-set env vars
// (VAULT_HANDOFF_VERIFY_KEYS, VAULT_DELEGATION_VERIFY_KEYS). Shape/format only: JSON array,
// objects, `kid` 1..128 unique, a PEM public-key envelope with the footer after the header.
// Messages carry the variable name, so each variable's messages stay byte-stable.

export type VerifyKeySetEntry = { kid: string; publicKeyPem: string }

export class VerifyKeySetParseError extends Error {}

const PEM_HEADER = '-----BEGIN PUBLIC KEY-----'
const PEM_FOOTER = '-----END PUBLIC KEY-----'
export const DEFAULT_PEM_MESSAGE = 'publicKeyPem must be a well-formed PEM public key block'

function parseJson(raw: string, varName: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw new VerifyKeySetParseError(`${varName} must be valid JSON`)
  }
}

// A bare `includes()` check on both markers accepts a reversed or duplicated-marker string
// (footer before header). Require the footer to start strictly after the header ends.
function isWellFormedPem(publicKeyPem: unknown): publicKeyPem is string {
  if (typeof publicKeyPem !== 'string') return false
  const headerIndex = publicKeyPem.indexOf(PEM_HEADER)
  const footerIndex = publicKeyPem.indexOf(PEM_FOOTER)
  return headerIndex !== -1 && footerIndex !== -1 && footerIndex >= headerIndex + PEM_HEADER.length
}

// Split out of parseVerifyKeySet to keep both under the repo's cyclomatic-complexity threshold.
function toEntry(
  item: unknown,
  seenKids: Set<string>,
  varName: string,
  pemMessage: string
): VerifyKeySetEntry {
  if (!item || typeof item !== 'object') {
    throw new VerifyKeySetParseError(`${varName} entries must be objects with kid/publicKeyPem`)
  }
  const kid = (item as Record<string, unknown>)['kid']
  const publicKeyPem = (item as Record<string, unknown>)['publicKeyPem']
  if (typeof kid !== 'string' || kid.length < 1 || kid.length > 128) {
    throw new VerifyKeySetParseError(
      `${varName} kid must be a non-empty string of at most 128 characters`
    )
  }
  if (!isWellFormedPem(publicKeyPem)) {
    throw new VerifyKeySetParseError(`${varName} ${pemMessage}`)
  }
  if (seenKids.has(kid)) {
    throw new VerifyKeySetParseError(`${varName} kid values must be unique`)
  }
  seenKids.add(kid)
  return { kid, publicKeyPem }
}

/** Throws VerifyKeySetParseError on any shape violation. An unset/empty value is an empty list. */
export function parseVerifyKeySet(
  raw: string | undefined,
  varName: string,
  pemMessage: string = DEFAULT_PEM_MESSAGE
): VerifyKeySetEntry[] {
  if (!raw) return []
  const parsed = parseJson(raw, varName)
  if (!Array.isArray(parsed)) {
    throw new VerifyKeySetParseError(`${varName} must be a JSON array`)
  }
  const seenKids = new Set<string>()
  return parsed.map((item) => toEntry(item, seenKids, varName, pemMessage))
}
