import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { deriveKey, encryptExportBundle, HKDF_INFO } from '@project-vault/crypto'
import { checkExportFormatVersion, decryptExportFile, parseExportBundle } from './import-service.js'
import { coerceRotationStatusForExport } from './service.js'
import { EXPORT_FORMAT_VERSION, MAX_IMPORT_CREDENTIALS } from './schema.js'

function emptyBundle(overrides: Record<string, unknown> = {}) {
  return {
    exportFormatVersion: EXPORT_FORMAT_VERSION,
    project: { name: 'p', description: null, tags: [] },
    credentials: [],
    credentialDependencies: [],
    rotations: [],
    certRecords: [],
    domainRecords: [],
    serviceEndpoints: [],
    statusPages: [],
    machineUsers: [],
    ...overrides,
  }
}

async function encryptFile(bundle: unknown, rawExportKey: string): Promise<Buffer> {
  const key = deriveKey(Buffer.from(rawExportKey, 'base64url'), HKDF_INFO.EXPORT)
  const encrypted = await encryptExportBundle(Buffer.from(JSON.stringify(bundle)), key)
  return Buffer.from(JSON.stringify(encrypted), 'utf8')
}

describe('project-export import-service (Story 28.9)', () => {
  describe('decryptExportFile (AC-3 no-oracle discipline)', () => {
    it('decrypts a valid file with the matching key', async () => {
      const rawExportKey = randomBytes(32).toString('base64url')
      const bundle = emptyBundle()
      const fileBuffer = await encryptFile(bundle, rawExportKey)
      const result = await decryptExportFile(fileBuffer, rawExportKey)
      expect(result.status).toBe('ok')
      if (result.status === 'ok') expect(JSON.parse(result.plaintext)).toEqual(bundle)
    })

    it('fails closed on the wrong key (AC-3 negative — no distinction from corruption)', async () => {
      const fileBuffer = await encryptFile(emptyBundle(), randomBytes(32).toString('base64url'))
      const wrongKey = randomBytes(32).toString('base64url')
      const result = await decryptExportFile(fileBuffer, wrongKey)
      expect(result.status).toBe('decrypt_failed')
    })

    it('fails closed on a corrupted/non-JSON file', async () => {
      const result = await decryptExportFile(
        Buffer.from('not json at all'),
        randomBytes(32).toString('base64url')
      )
      expect(result.status).toBe('decrypt_failed')
    })

    it('fails closed on a malformed exportKey', async () => {
      const fileBuffer = await encryptFile(emptyBundle(), randomBytes(32).toString('base64url'))
      const result = await decryptExportFile(fileBuffer, 'not-a-valid-base64url-key!!')
      expect(result.status).toBe('decrypt_failed')
    })
  })

  describe('checkExportFormatVersion (D7)', () => {
    it('accepts the currently-supported version', () => {
      expect(checkExportFormatVersion({ exportFormatVersion: 1 })).toEqual({ status: 'ok' })
    })

    it('rejects a future/unsupported version before interpreting anything else', () => {
      expect(
        checkExportFormatVersion({ exportFormatVersion: 2, credentials: 'not-even-an-array' })
      ).toEqual({
        status: 'unsupported',
        found: 2,
      })
    })

    it('rejects a missing exportFormatVersion field', () => {
      expect(checkExportFormatVersion({})).toEqual({ status: 'unsupported', found: undefined })
    })
  })

  describe('parseExportBundle (AC-3 Red Team: strict schema + size caps)', () => {
    it('accepts a well-formed empty bundle', () => {
      expect(parseExportBundle(emptyBundle()).status).toBe('ok')
    })

    it('rejects a malformed shape (credentials is a string, not an array)', () => {
      const result = parseExportBundle(emptyBundle({ credentials: 'not-an-array' }))
      expect(result.status).toBe('invalid_payload')
    })

    it('rejects an oversized credentials array (resource-exhaustion guard)', () => {
      const tooMany = Array.from({ length: MAX_IMPORT_CREDENTIALS + 1 }, () => ({
        name: 'x',
        description: null,
        tags: [],
        expiresAt: null,
        alertLeadDays: [],
        notifiedLeadDays: [],
        rotationSchedule: null,
        retentionCount: 3,
        cacheable: true,
        createdAt: null,
        currentVersionNumber: null,
        versions: [],
      }))
      const result = parseExportBundle(emptyBundle({ credentials: tooMany }))
      expect(result.status).toBe('invalid_payload')
    })

    it('rejects an unknown/extra field (strict schema)', () => {
      const result = parseExportBundle(emptyBundle({ credentialShares: [] }))
      expect(result.status).toBe('invalid_payload')
    })

    // AC-7/D5: the schema has no credentialShares field at all — this is a compile-time/
    // definitional guarantee, asserted here as a lightweight regression check that nobody
    // reintroduces one.
    it('has no share-derived field in the bundle shape', () => {
      const result = parseExportBundle(emptyBundle())
      expect(result.status).toBe('ok')
      if (result.status === 'ok') {
        expect(Object.keys(result.bundle)).not.toContain('credentialShares')
      }
    })
  })

  describe('coerceRotationStatusForExport (D5/AC-6)', () => {
    it('coerces every non-terminal status to completed', () => {
      expect(coerceRotationStatusForExport('in_progress')).toBe('completed')
      expect(coerceRotationStatusForExport('staged')).toBe('completed')
      expect(coerceRotationStatusForExport('stale_recovery')).toBe('completed')
    })

    it('leaves terminal statuses unchanged', () => {
      for (const status of [
        'promoted',
        'retired',
        'completed',
        'abandoned',
        'break_glass_complete',
      ]) {
        expect(coerceRotationStatusForExport(status)).toBe(status)
      }
    })
  })
})
