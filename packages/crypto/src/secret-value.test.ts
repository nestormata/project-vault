import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { encrypt } from './aes.js'
import { clearVaultKey, setVaultKey, withSecret } from './secret-value.js'

const KEY = randomBytes(32)

afterEach(() => {
  clearVaultKey()
})

describe('Story 42.4: withSecret — corrupted/sealed-path crash coverage', () => {
  it('positive: round-trips a well-formed EncryptedValue into the callback', async () => {
    setVaultKey(KEY)
    const plaintext = Buffer.from('super secret value')
    const encrypted = await encrypt(plaintext, KEY)

    const result = await withSecret(encrypted, async (buf) => buf.toString('utf8'))

    expect(result).toBe('super secret value')
  })

  it('negative: throws (never silently returns) when the vault key is unset', async () => {
    clearVaultKey()
    const encrypted = await encrypt(Buffer.from('irrelevant'), KEY)

    await expect(withSecret(encrypted, async (buf) => buf)).rejects.toThrow(/vault is sealed/)
  })

  it('negative: a tampered EncryptedValue (flipped ciphertext hex char) throws from the GCM auth-tag check, and fn is never invoked', async () => {
    setVaultKey(KEY)
    const encrypted = await encrypt(Buffer.from('secret payload'), KEY)
    const tamperedChar = encrypted.ciphertext[0] === '0' ? '1' : '0'
    const tampered = { ...encrypted, ciphertext: tamperedChar + encrypted.ciphertext.slice(1) }
    const fn = vi.fn(async (buf: Buffer) => buf)

    await expect(withSecret(tampered, fn)).rejects.toThrow(/corrupted ciphertext/)
    expect(fn).not.toHaveBeenCalled()
  })

  it('negative: a tampered EncryptedValue (flipped tag hex char) throws from the GCM auth-tag check, and fn is never invoked', async () => {
    setVaultKey(KEY)
    const encrypted = await encrypt(Buffer.from('secret payload'), KEY)
    const tamperedChar = encrypted.tag[0] === '0' ? '1' : '0'
    const tampered = { ...encrypted, tag: tamperedChar + encrypted.tag.slice(1) }
    const fn = vi.fn(async (buf: Buffer) => buf)

    await expect(withSecret(tampered, fn)).rejects.toThrow(/corrupted ciphertext/)
    expect(fn).not.toHaveBeenCalled()
  })

  it('zeroing guarantee: the plaintext Buffer passed to fn is zeroed after withSecret rejects, even when fn itself throws', async () => {
    setVaultKey(KEY)
    const encrypted = await encrypt(Buffer.from('never outlive a failing callback'), KEY)
    let capturedBuffer: Buffer | undefined

    await expect(
      withSecret(encrypted, async (buf) => {
        capturedBuffer = buf
        throw new Error('callback failure')
      })
    ).rejects.toThrow('callback failure')

    expect(capturedBuffer).toBeDefined()
    expect(capturedBuffer?.every((byte) => byte === 0)).toBe(true)
  })
})
