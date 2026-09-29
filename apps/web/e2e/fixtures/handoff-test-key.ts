import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto'

/**
 * Story 60.6 D1: the e2e stack's TEST-ONLY handoff signing key and the constants the e2e compose
 * override (docker-compose.e2e.yml) must agree with. scripts/e2e-stack.test.ts imports this file
 * and pins every value below against the override, so rotating the seed or changing a default
 * breaks loudly in PR CI instead of at nightly (E1).
 *
 * The seed is public by design. Only the PUBLIC half is committed (in the override); the private
 * key is derived here at runtime, so no private-key PEM ever lands in the repo
 * (scripts/check-public-safety.ts). The key is trusted only by an api whose
 * VAULT_HANDOFF_INSTANCE_ID is `pv-e2e`, which exists only in the e2e override, and every token
 * carries `aud = pv:pv-e2e`, so it can never verify against a real instance. Never reuse the e2e
 * override, this kid or this instance id outside the e2e stack.
 */

export const HANDOFF_E2E_KID = 'pv-e2e-test-only-1'
export const HANDOFF_E2E_INSTANCE_ID = 'pv-e2e'
/** Pinned as a literal on the e2e api (never `${VAULT_HANDOFF_ISSUER:-…}`, see AC1). */
export const HANDOFF_E2E_ISSUER = 'https://app.centralizeme.com'
export const HANDOFF_E2E_PROVIDER = 'centralizeme-handoff'
/**
 * The fake CentralizeMe interstitial's port on 127.0.0.1. The web allowlist is fixed at compose-up
 * time, so if you override E2E_HANDOFF_STUB_PORT, set it in the shell for BOTH `make e2e`'s stack
 * start and the Playwright run (E1a).
 */
export const HANDOFF_E2E_STUB_DEFAULT_PORT = 48999

const HANDOFF_E2E_SEED = Buffer.alloc(32, 0x60)
// The fixed DER header of an Ed25519 PKCS#8 private key (RFC 8410); the 32-byte seed follows it.
const ED25519_PKCS8_PREFIX = Buffer.from([
  ...[0x30, 0x2e], // SEQUENCE, 46 bytes
  ...[0x02, 0x01, 0x00], // INTEGER version 0
  ...[0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70], // AlgorithmIdentifier: OID 1.3.101.112 (Ed25519)
  ...[0x04, 0x22, 0x04, 0x20], // OCTET STRING wrapping the 32-byte seed OCTET STRING
])

export function handoffE2ePrivateKey(): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, HANDOFF_E2E_SEED]),
    format: 'der',
    type: 'pkcs8',
  })
}

export function handoffE2ePublicKeyPem(): string {
  return createPublicKey(handoffE2ePrivateKey()).export({ format: 'pem', type: 'spki' }).toString()
}
