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

  it('keeps header sensitive fields covered by Pino redaction', () => {
    for (const field of HEADER_SENSITIVE_LOG_FIELDS) {
      expect(pinoCoversField(field), `${field} missing from PINO_REDACT_PATHS`).toBe(true)
    }
  })
})
