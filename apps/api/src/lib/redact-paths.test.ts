import { describe, expect, it } from 'vitest'
import {
  BODY_SENSITIVE_LOG_FIELDS,
  HEADER_SENSITIVE_LOG_FIELDS,
  PINO_REDACT_PATHS,
} from './redact-paths.js'
import { REDACTED_BODY_FIELDS } from '../plugins/redact-secrets.js'

function pinoCoversField(field: string): boolean {
  return PINO_REDACT_PATHS.some((path) => path.endsWith(`.${field}`) || path === `*.${field}`)
}

describe('sensitive log field registry coverage', () => {
  it('keeps body sensitive fields covered by Pino and manual redaction', () => {
    for (const field of BODY_SENSITIVE_LOG_FIELDS) {
      expect(pinoCoversField(field), `${field} missing from PINO_REDACT_PATHS`).toBe(true)
      expect(REDACTED_BODY_FIELDS.has(field), `${field} missing from REDACTED_BODY_FIELDS`).toBe(
        true
      )
    }
  })

  it('covers both admin URL spellings and redacts an env-shaped payload', () => {
    expect(BODY_SENSITIVE_LOG_FIELDS).toEqual(
      expect.arrayContaining(['adminDatabaseUrl', 'ADMIN_DATABASE_URL'])
    )
    expect(REDACTED_BODY_FIELDS.has('adminDatabaseUrl')).toBe(true)
    expect(REDACTED_BODY_FIELDS.has('ADMIN_DATABASE_URL')).toBe(true)
    expect(PINO_REDACT_PATHS).toEqual(
      expect.arrayContaining(['*.adminDatabaseUrl', '*.ADMIN_DATABASE_URL'])
    )
  })

  it('keeps header sensitive fields covered by Pino redaction', () => {
    for (const field of HEADER_SENSITIVE_LOG_FIELDS) {
      expect(pinoCoversField(field), `${field} missing from PINO_REDACT_PATHS`).toBe(true)
    }
  })

  // Story 28.9 AC-2: the export key is never carried in a request body — it's a response header
  // (create-export) or a multipart form field (import) — so it needs its own explicit path
  // rather than relying on the generic req.body.* coverage above.
  it('redacts the X-Export-Key response header via a dedicated pino path', () => {
    expect(PINO_REDACT_PATHS).toContain('res.headers["x-export-key"]')
  })

  it('redacts exportKey via the generic body/wildcard registry too (multipart import field)', () => {
    expect(BODY_SENSITIVE_LOG_FIELDS).toContain('exportKey')
    expect(REDACTED_BODY_FIELDS.has('exportKey')).toBe(true)
  })
})
