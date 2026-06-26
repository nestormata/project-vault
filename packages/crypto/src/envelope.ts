const ENVELOPE_HALF_BYTES = 16 // 128-bit half → 256-bit IKM when concatenated

/**
 * Combine env half + file half into 32-byte IKM via concatenation.
 * Neither half is sufficient alone; both required at init/unseal.
 */
export function combineEnvelopeHalves(envHalf: Buffer, fileHalf: Buffer): Buffer {
  if (envHalf.length !== ENVELOPE_HALF_BYTES || fileHalf.length !== ENVELOPE_HALF_BYTES) {
    throw new Error(
      `combineEnvelopeHalves: each half must be ${ENVELOPE_HALF_BYTES} bytes, ` +
        `got env=${envHalf.length} file=${fileHalf.length}`
    )
  }
  return Buffer.concat([envHalf, fileHalf])
}

/** Parse VAULT_ENVELOPE_KEY_HALF env value: 32 lowercase hex chars → 16 bytes. */
export function parseEnvelopeEnvHalf(hex: string): Buffer {
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new Error(
      'VAULT_ENVELOPE_KEY_HALF must be exactly 32 lowercase hex characters (16 bytes)'
    )
  }
  return Buffer.from(hex, 'hex')
}
