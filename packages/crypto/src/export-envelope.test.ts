import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decryptExportBundle, encryptExportBundle } from './export-envelope.js'

describe('project export/import envelope (Story 28.9 D2/D3)', () => {
  it('round-trips plaintext through encrypt/decrypt with the same key', async () => {
    const key = randomBytes(32)
    const plaintext = Buffer.from(JSON.stringify({ exportFormatVersion: 1, hello: 'world' }))
    const encrypted = await encryptExportBundle(plaintext, key)
    const decrypted = await decryptExportBundle(encrypted, key)
    expect(decrypted.toString('utf8')).toEqual(plaintext.toString('utf8'))
  })

  it('fails closed (no oracle) on the wrong key', async () => {
    const plaintext = Buffer.from('secret bundle')
    const encrypted = await encryptExportBundle(plaintext, randomBytes(32))
    await expect(decryptExportBundle(encrypted, randomBytes(32))).rejects.toThrow()
  })

  it('fails closed on a tampered ciphertext', async () => {
    const key = randomBytes(32)
    const encrypted = await encryptExportBundle(Buffer.from('secret bundle'), key)
    const tampered = { ...encrypted, ciphertext: encrypted.ciphertext.replace(/^./, 'f') }
    await expect(decryptExportBundle(tampered, key)).rejects.toThrow()
  })
})
