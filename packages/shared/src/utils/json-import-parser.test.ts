import { describe, expect, it } from 'vitest'
import { ImportValidationError, parseJsonImportFile } from './json-import-parser.js'

describe('parseJsonImportFile', () => {
  it('parses string values', () => {
    expect(parseJsonImportFile('{ "KEY": "value" }')).toEqual({
      entries: [{ name: 'KEY', value: 'value' }],
      warnings: [],
    })
  })

  it('coerces numbers and booleans to strings', () => {
    expect(parseJsonImportFile('{ "PORT": 3000, "DEBUG": true }')).toEqual({
      entries: [
        { name: 'PORT', value: '3000' },
        { name: 'DEBUG', value: 'true' },
      ],
      warnings: [],
    })
  })

  it('treats null as empty string with warning', () => {
    expect(parseJsonImportFile('{ "KEY": null }')).toEqual({
      entries: [{ name: 'KEY', value: '' }],
      warnings: [{ line: 0, reason: 'empty_value', raw: 'KEY' }],
    })
  })

  it('throws on nested values', () => {
    expect(() => parseJsonImportFile('{ "KEY": { "nested": true } }')).toThrow(
      ImportValidationError
    )
    try {
      parseJsonImportFile('{ "KEY": { "nested": true } }')
    } catch (error) {
      expect(error).toMatchObject({ code: 'nested_value' })
    }
  })

  it('throws on array root', () => {
    expect(() => parseJsonImportFile('[{ "K": "v" }]')).toThrow(ImportValidationError)
    try {
      parseJsonImportFile('[{ "K": "v" }]')
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid_json_structure' })
    }
  })

  it('throws on string root', () => {
    expect(() => parseJsonImportFile('"just a string"')).toThrow(ImportValidationError)
  })

  it('throws on invalid json', () => {
    expect(() => parseJsonImportFile('{not valid json')).toThrow(ImportValidationError)
    try {
      parseJsonImportFile('{not valid json')
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid_json' })
    }
  })

  it('accepts empty object', () => {
    expect(parseJsonImportFile('{}')).toEqual({ entries: [], warnings: [] })
  })

  it('preserves entry order for multiple keys', () => {
    expect(parseJsonImportFile('{ "K1": "v1", "K2": "v2", "K3": "v3" }')).toEqual({
      entries: [
        { name: 'K1', value: 'v1' },
        { name: 'K2', value: 'v2' },
        { name: 'K3', value: 'v3' },
      ],
      warnings: [],
    })
  })
})
