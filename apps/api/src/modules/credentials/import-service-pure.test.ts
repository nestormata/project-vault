import { describe, expect, it } from 'vitest'
import type { PendingImportItemRecord } from '@project-vault/db/schema'
import {
  detectImportFileType,
  parseImportFileContent,
  resolveImportAction,
} from './import-service.js'

describe('detectImportFileType', () => {
  it('detects .env files case-insensitively', () => {
    expect(detectImportFileType('secrets.env')).toBe('env')
    expect(detectImportFileType('SECRETS.ENV')).toBe('env')
  })

  it('detects .json files case-insensitively', () => {
    expect(detectImportFileType('secrets.json')).toBe('json')
    expect(detectImportFileType('SECRETS.JSON')).toBe('json')
  })

  it('returns unsupported for an unrecognized extension', () => {
    expect(detectImportFileType('secrets.txt')).toBe('unsupported')
  })

  it('returns unsupported when filename is undefined', () => {
    expect(detectImportFileType(undefined)).toBe('unsupported')
  })
})

describe('parseImportFileContent', () => {
  it('parses .env-shaped content via the env parser', () => {
    const result = parseImportFileContent('env', 'FOO=bar\nBAZ=qux')
    expect(result.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'FOO', value: 'bar' })])
    )
  })

  it('parses json-shaped content via the json parser', () => {
    const result = parseImportFileContent('json', JSON.stringify({ FOO: 'bar' }))
    expect(result.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'FOO', value: 'bar' })])
    )
  })
})

function importItem(overrides: Partial<PendingImportItemRecord> = {}): PendingImportItemRecord {
  return {
    name: 'FOO',
    encryptedValue: {} as PendingImportItemRecord['encryptedValue'],
    keyVersion: 1,
    conflictsWith: null,
    suggestedAction: 'create_new',
    ...overrides,
  }
}

describe('resolveImportAction', () => {
  it('uses the per-item override when present, ignoring the default action', () => {
    const item = importItem({ name: 'FOO' })
    expect(resolveImportAction(item, 'skip', { FOO: 'create_new' })).toBe('create_new')
  })

  it('falls back to the default action when no override is present for this item', () => {
    const item = importItem({ name: 'FOO' })
    expect(resolveImportAction(item, 'skip', { OTHER: 'create_new' })).toBe('skip')
    expect(resolveImportAction(item, 'skip', undefined)).toBe('skip')
  })

  it('coerces "new_version" to "create_new" when the item has no actual conflict', () => {
    const item = importItem({ conflictsWith: null })
    expect(resolveImportAction(item, 'new_version', undefined)).toBe('create_new')
  })

  it('keeps "new_version" as-is when the item does have a real conflict', () => {
    const item = importItem({ conflictsWith: 'existing-credential-id' })
    expect(resolveImportAction(item, 'new_version', undefined)).toBe('new_version')
  })
})
