import { describe, it, expect, vi } from 'vitest'
import { AwsKmsProvider, KmsProviderError } from './kms-provider.js'

function fakeClient(sendImpl: (command: unknown) => Promise<unknown>) {
  return { send: vi.fn(sendImpl) }
}

const KEY_ID = 'arn:aws:kms:us-east-1:123456789012:key/abcd-1234-efgh-5678-ijkl90mnopqr'

describe('Story 1.14 AC-21/AC-23: AwsKmsProvider', () => {
  describe('generateDataKey', () => {
    it('AC-1: calls GenerateDataKeyCommand with KeyId/KeySpec and returns {plaintext, ciphertextBlob}', async () => {
      const plaintext = Buffer.from('a'.repeat(32))
      const ciphertext = Buffer.from('encrypted-blob-bytes')
      const client = fakeClient(async (command) => {
        const input = (command as { input: { KeyId: string; KeySpec: string } }).input
        expect(input.KeyId).toBe(KEY_ID)
        expect(input.KeySpec).toBe('AES_256')
        return { Plaintext: plaintext, CiphertextBlob: ciphertext }
      })
      const provider = new AwsKmsProvider(client)

      const result = await provider.generateDataKey(KEY_ID)

      expect(result.plaintext.equals(plaintext)).toBe(true)
      expect(result.ciphertextBlob).toBe(ciphertext.toString('base64'))
    })

    it('AC-3: network/timeout errors map to kind=unreachable', async () => {
      const client = fakeClient(async () => {
        const err = new Error('connect ETIMEDOUT') as Error & { name: string }
        err.name = 'ETIMEDOUT'
        throw err
      })
      const provider = new AwsKmsProvider(client)

      await expect(provider.generateDataKey(KEY_ID)).rejects.toMatchObject({
        kind: 'unreachable',
      })
    })

    it('AC-4: NotFoundException maps to kind=not_found', async () => {
      const client = fakeClient(async () => {
        const err = new Error('key not found') as Error & { name: string }
        err.name = 'NotFoundException'
        throw err
      })
      const provider = new AwsKmsProvider(client)

      await expect(provider.generateDataKey(KEY_ID)).rejects.toMatchObject({ kind: 'not_found' })
    })

    it('AC-4 edge: DisabledException and KMSInvalidStateException also map to kind=not_found', async () => {
      for (const name of ['DisabledException', 'KMSInvalidStateException']) {
        const client = fakeClient(async () => {
          const err = new Error('key unusable') as Error & { name: string }
          err.name = name
          throw err
        })
        const provider = new AwsKmsProvider(client)
        await expect(provider.generateDataKey(KEY_ID)).rejects.toMatchObject({
          kind: 'not_found',
        })
      }
    })

    it('AC-5: AccessDeniedException maps to kind=permission_denied and never leaks raw error text', async () => {
      const client = fakeClient(async () => {
        const err = new Error(
          'User arn:aws:iam::123456789012:role/secret-role is not authorized'
        ) as Error & { name: string }
        err.name = 'AccessDeniedException'
        throw err
      })
      const provider = new AwsKmsProvider(client)

      await expect(provider.generateDataKey(KEY_ID)).rejects.toMatchObject({
        kind: 'permission_denied',
      })
      try {
        await provider.generateDataKey(KEY_ID)
        expect.unreachable()
      } catch (err) {
        expect((err as Error).message).not.toContain('secret-role')
      }
    })

    it('unrecognized SDK exception maps to kind=unknown without leaking raw message', async () => {
      const client = fakeClient(async () => {
        throw new Error('some brand-new AWS exception with sensitive detail')
      })
      const provider = new AwsKmsProvider(client)

      try {
        await provider.generateDataKey(KEY_ID)
        expect.unreachable()
      } catch (err) {
        expect(err).toBeInstanceOf(KmsProviderError)
        expect((err as KmsProviderError).kind).toBe('unknown')
        expect((err as Error).message).not.toContain('sensitive detail')
      }
    })

    it('throttling/limit-exceeded exceptions map to kind=unreachable (not unknown)', async () => {
      const client = fakeClient(async () => {
        const err = new Error('rate exceeded') as Error & { name: string }
        err.name = 'ThrottlingException'
        throw err
      })
      const provider = new AwsKmsProvider(client)

      await expect(provider.generateDataKey(KEY_ID)).rejects.toMatchObject({
        kind: 'unreachable',
      })
    })
  })

  describe('decryptDataKey', () => {
    it('AC-9 edge: does not require KeyId — only sends CiphertextBlob', async () => {
      const plaintext = Buffer.from('b'.repeat(32))
      const ciphertextB64 = Buffer.from('ciphertext-bytes').toString('base64')
      const client = fakeClient(async (command) => {
        const input = (command as { input: Record<string, unknown> }).input
        expect(input['CiphertextBlob']).toBeInstanceOf(Buffer)
        expect(input).not.toHaveProperty('KeyId')
        return { Plaintext: plaintext }
      })
      const provider = new AwsKmsProvider(client)

      const result = await provider.decryptDataKey(ciphertextB64)

      expect(result.equals(plaintext)).toBe(true)
    })

    it('AC-11: network/timeout errors map to kind=unreachable', async () => {
      const client = fakeClient(async () => {
        const err = new Error('network unreachable') as Error & { name: string }
        err.name = 'NetworkingError'
        throw err
      })
      const provider = new AwsKmsProvider(client)

      await expect(provider.decryptDataKey('AAAA')).rejects.toMatchObject({ kind: 'unreachable' })
    })

    it('AC-12: deleted/disabled key maps to kind=not_found (key-service.ts remaps to kms_key_unavailable for unseal)', async () => {
      const client = fakeClient(async () => {
        const err = new Error('key gone') as Error & { name: string }
        err.name = 'KMSInvalidStateException'
        throw err
      })
      const provider = new AwsKmsProvider(client)

      await expect(provider.decryptDataKey('AAAA')).rejects.toMatchObject({ kind: 'not_found' })
    })

    it('AC-13: AccessDeniedException maps to kind=permission_denied', async () => {
      const client = fakeClient(async () => {
        const err = new Error('access denied') as Error & { name: string }
        err.name = 'AccessDeniedException'
        throw err
      })
      const provider = new AwsKmsProvider(client)

      await expect(provider.decryptDataKey('AAAA')).rejects.toMatchObject({
        kind: 'permission_denied',
      })
    })

    it('AC-16 negative: ExpiredTokenException (STS session expiry) maps to kind=permission_denied, not a crash/hang', async () => {
      const client = fakeClient(async () => {
        const err = new Error('token expired') as Error & { name: string }
        err.name = 'ExpiredTokenException'
        throw err
      })
      const provider = new AwsKmsProvider(client)

      await expect(provider.decryptDataKey('AAAA')).rejects.toMatchObject({
        kind: 'permission_denied',
      })
    })
  })
})
