import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { combineEnvelopeHalves, parseEnvelopeEnvHalf } from './envelope.js'

describe('combineEnvelopeHalves', () => {
  it('concatenates two 16-byte halves into a 32-byte IKM', () => {
    const envHalf = randomBytes(16)
    const fileHalf = randomBytes(16)
    const ikm = combineEnvelopeHalves(envHalf, fileHalf)
    expect(ikm.length).toBe(32)
    expect(ikm.subarray(0, 16).equals(envHalf)).toBe(true)
    expect(ikm.subarray(16, 32).equals(fileHalf)).toBe(true)
  })

  it('throws if either half is the wrong size', () => {
    expect(() => combineEnvelopeHalves(randomBytes(15), randomBytes(16))).toThrow(/16 bytes/)
    expect(() => combineEnvelopeHalves(randomBytes(16), randomBytes(8))).toThrow(/16 bytes/)
  })
})

describe('parseEnvelopeEnvHalf', () => {
  it('parses 32 lowercase hex chars into a 16-byte Buffer', () => {
    const hex = randomBytes(16).toString('hex')
    const buf = parseEnvelopeEnvHalf(hex)
    expect(buf.toString('hex')).toBe(hex)
  })

  it('rejects non-hex or wrong-length input', () => {
    expect(() => parseEnvelopeEnvHalf('not-hex')).toThrow(/32 lowercase hex/)
    expect(() => parseEnvelopeEnvHalf('AB'.repeat(16))).toThrow(/32 lowercase hex/) // uppercase rejected
    expect(() => parseEnvelopeEnvHalf('ab'.repeat(8))).toThrow(/32 lowercase hex/) // too short
  })
})
