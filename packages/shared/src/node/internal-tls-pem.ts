import { X509Certificate, createPrivateKey, type KeyObject } from 'node:crypto'

/**
 * Story 43.16: the one strict decoder for the Fly demo's internal-TLS material, shared by the api
 * listener (`API_TLS_*`), every Postgres client (`DATABASE_TLS_*`, via `@project-vault/db`'s
 * `pgTlsOptions`) and the web's `internalApiFetch` (`API_TLS_CA_B64` / `API_TLS_CLIENT_*`).
 *
 * Node-only (`node:crypto`): published as the `@project-vault/shared/node-tls` subpath, never from
 * the browser-safe package index.
 *
 * Values are single-line base64 of PEM. Error messages name the variable and the failure class
 * only — never the encoded or decoded content (NFR-SEC4).
 */

export class InternalTlsConfigError extends Error {
  readonly variable: string

  constructor(variable: string, message: string) {
    super(message)
    this.name = 'InternalTlsConfigError'
    this.variable = variable
  }
}

/** `id-kp-clientAuth`. Node exposes a certificate's extended key usages as `x509.keyUsage`. */
export const CLIENT_AUTH_EKU_OID = '1.3.6.1.5.5.7.3.2'

const ENCRYPTED_KEY_ERROR_CODES = new Set([
  'ERR_MISSING_PASSPHRASE',
  'ERR_OSSL_CRYPTO_INTERRUPTED_OR_CANCELLED',
])
const STRICT_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const CERT_BEGIN = '-----BEGIN CERTIFICATE-----'
const CERT_END = '-----END CERTIFICATE-----'

/** Any env-shaped object; only string values are read (parsed env objects carry numbers too). */
export type EnvLike = Readonly<Record<string, unknown>>

/** Reads a `*_B64` variable: all whitespace (including wrapped-base64 newlines) is stripped, and
 * an empty or whitespace-only value is treated as unset. */
export function readB64Var(env: EnvLike, name: string): string | undefined {
  const raw = new Map(Object.entries(env)).get(name)
  if (typeof raw !== 'string') return undefined
  const compact = raw.replaceAll(/\s/g, '')
  return compact === '' ? undefined : compact
}

function invalid(name: string): InternalTlsConfigError {
  return new InternalTlsConfigError(name, `${name} is not valid base64 PEM`)
}

// `Buffer.from(x, 'base64')` never throws — it silently drops invalid characters — so a value must
// match the strict alphabet AND survive a canonical round trip before it is trusted.
function decodeStrictBase64(name: string, value: string): string {
  if (!STRICT_BASE64.test(value)) throw invalid(name)
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) throw invalid(name)
  return bytes.toString('utf8')
}

function splitCertificateBlocks(text: string): string[] {
  const blocks: string[] = []
  let cursor = text.indexOf(CERT_BEGIN)
  while (cursor !== -1) {
    const end = text.indexOf(CERT_END, cursor)
    if (end === -1) return []
    blocks.push(`${text.slice(cursor, end + CERT_END.length)}\n`)
    cursor = text.indexOf(CERT_BEGIN, end)
  }
  return blocks
}

export type ParsedCertBundle = { pem: string; certs: X509Certificate[] }

/** A certificate or a PEM bundle (a chain, or several CAs for an overlap rotation). */
export function parseCertBundleB64(name: string, value: string): ParsedCertBundle {
  const blocks = splitCertificateBlocks(decodeStrictBase64(name, value))
  if (blocks.length === 0) throw invalid(name)
  try {
    return { pem: blocks.join(''), certs: blocks.map((block) => new X509Certificate(block)) }
  } catch {
    throw invalid(name)
  }
}

export type ParsedPrivateKey = { pem: string; key: KeyObject }

export function parsePrivateKeyB64(name: string, value: string): ParsedPrivateKey {
  const text = decodeStrictBase64(name, value)
  try {
    return { pem: text, key: createPrivateKey(text) }
  } catch (error) {
    // A passphrase-protected key (PKCS#8 or legacy PEM) fails without a passphrase with one of
    // these codes: Node's own check, or OpenSSL's cancelled passphrase callback.
    if (ENCRYPTED_KEY_ERROR_CODES.has(String((error as NodeJS.ErrnoException).code))) {
      throw new InternalTlsConfigError(name, `${name}: encrypted private keys are not supported`)
    }
    throw invalid(name)
  }
}

export type TlsMaterialSpec = {
  certVar: string
  keyVar: string
  caVar: string
  /**
   * `server`: the CA is the client-cert CA and needs the server pair (mTLS needs TLS).
   * `client`: the CA pins the server; a client pair without it is a misconfiguration.
   */
  role: 'server' | 'client'
}

export type ResolvedTlsMaterial = {
  cert?: { pem: string; leaf: X509Certificate }
  key?: string
  ca?: string
}

function assertPairRule(spec: TlsMaterialSpec, cert: string | undefined, key: string | undefined) {
  if (cert !== undefined && key === undefined) {
    throw new InternalTlsConfigError(
      spec.keyVar,
      `${spec.keyVar} is required when ${spec.certVar} is set`
    )
  }
  if (key !== undefined && cert === undefined) {
    throw new InternalTlsConfigError(
      spec.certVar,
      `${spec.certVar} is required when ${spec.keyVar} is set`
    )
  }
}

function assertCaRule(spec: TlsMaterialSpec, cert: string | undefined, ca: string | undefined) {
  if (spec.role === 'server' && ca !== undefined && cert === undefined) {
    throw new InternalTlsConfigError(
      spec.caVar,
      `${spec.caVar} requires ${spec.certVar} and ${spec.keyVar}`
    )
  }
  if (spec.role === 'client' && cert !== undefined && ca === undefined) {
    throw new InternalTlsConfigError(
      spec.caVar,
      `${spec.caVar} is required when ${spec.certVar} is set`
    )
  }
}

/**
 * Validates and decodes one cert/key/CA triple. Returns `{}` when all three are unset (TLS off).
 * Throws `InternalTlsConfigError` (naming the variable at fault) on any misconfiguration.
 */
export function resolveTlsMaterial(env: EnvLike, spec: TlsMaterialSpec): ResolvedTlsMaterial {
  const certValue = readB64Var(env, spec.certVar)
  const keyValue = readB64Var(env, spec.keyVar)
  const caValue = readB64Var(env, spec.caVar)
  assertPairRule(spec, certValue, keyValue)
  assertCaRule(spec, certValue, caValue)

  const material: ResolvedTlsMaterial = {}
  if (certValue !== undefined && keyValue !== undefined) {
    const bundle = parseCertBundleB64(spec.certVar, certValue)
    const key = parsePrivateKeyB64(spec.keyVar, keyValue)
    const leaf = bundle.certs[0] as X509Certificate
    if (!leaf.checkPrivateKey(key.key)) {
      throw new InternalTlsConfigError(spec.keyVar, `${spec.keyVar} does not match ${spec.certVar}`)
    }
    material.cert = { pem: bundle.pem, leaf }
    material.key = key.pem
  }
  if (caValue !== undefined) material.ca = parseCertBundleB64(spec.caVar, caValue).pem
  return material
}

export type CertificateExpiry = {
  notAfter: string
  secondsRemaining: number
  daysRemaining: number
}

export function certificateExpiry(cert: X509Certificate, now: Date): CertificateExpiry {
  const notAfter = new Date(cert.validTo)
  const secondsRemaining = Math.floor((notAfter.getTime() - now.getTime()) / 1000)
  return {
    notAfter: notAfter.toISOString(),
    secondsRemaining,
    daysRemaining: Math.floor(secondsRemaining / 86_400),
  }
}

export function hasClientAuthEku(cert: X509Certificate): boolean {
  return (cert.keyUsage ?? []).includes(CLIENT_AUTH_EKU_OID)
}

/** The Story 43.16 AC-9 / AC-14 expiry-warning threshold. */
export const INTERNAL_TLS_EXPIRY_WARN_DAYS = 30
