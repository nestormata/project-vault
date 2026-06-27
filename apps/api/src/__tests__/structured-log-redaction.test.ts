import { describe, expect, it } from 'vitest'
import { createLoggerConfig } from '../lib/logger.js'
import { createLogCaptureStream } from './helpers/capture-logs.js'

const RAW_PASSWORD = 'raw-password'
const RAW_PASSPHRASE = 'raw-passphrase'
const RAW_SECRET = 'raw-secret'
const RAW_CREDENTIAL_VALUE = 'raw-credential-value'
const RAW_RECOVERY_CODE = 'RAW-RECOVERY-CODE'
const RAW_TOTP = '123456'
const RAW_MASTER_KEY_PATH = '/run/secrets/raw-master-key'

function capturedLogger() {
  const { stream, lines } = createLogCaptureStream()
  const logger = createLoggerConfig(
    { NODE_ENV: 'test', LOG_LEVEL: 'info', SERVICE_NAME: 'api' },
    stream
  )
  return { logger, lines }
}

describe('structured log redaction', () => {
  it('redacts sensitive values in request-shaped payloads', () => {
    const { logger, lines } = capturedLogger()

    logger.info(
      {
        eventType: 'test.redaction',
        req: {
          headers: {
            authorization: 'Bearer raw-jwt-token',
            cookie: 'session=raw-cookie',
          },
          body: {
            password: RAW_PASSWORD,
            passphrase: RAW_PASSPHRASE,
            masterKeyPath: RAW_MASTER_KEY_PATH,
            secret: RAW_SECRET,
            value: RAW_CREDENTIAL_VALUE,
            totp: RAW_TOTP,
            recoveryCode: RAW_RECOVERY_CODE,
          },
        },
      },
      'redaction test'
    )

    const combined = lines.join('')
    for (const forbidden of [
      'raw-jwt-token',
      'raw-cookie',
      RAW_PASSWORD,
      RAW_PASSPHRASE,
      RAW_MASTER_KEY_PATH,
      RAW_SECRET,
      RAW_CREDENTIAL_VALUE,
      RAW_TOTP,
      RAW_RECOVERY_CODE,
    ]) {
      expect(combined).not.toContain(forbidden)
    }
    expect(combined).toContain('[REDACTED]')
  })

  it('redacts single-level structured secret fields used by route handler logs', () => {
    const { logger, lines } = capturedLogger()

    logger.info(
      {
        eventType: 'test.redaction',
        body: {
          password: RAW_PASSWORD,
          passphrase: RAW_PASSPHRASE,
          secret: RAW_SECRET,
          masterKeyPath: RAW_MASTER_KEY_PATH,
          envelopeKeyPath: '/run/secrets/raw-envelope-key',
          recoveryCode: RAW_RECOVERY_CODE,
          totp: RAW_TOTP,
          value: RAW_CREDENTIAL_VALUE,
        },
      },
      'redaction test'
    )

    const combined = lines.join('')
    expect(combined).not.toContain(RAW_CREDENTIAL_VALUE)
    expect(combined).toContain('[REDACTED]')
  })
})
