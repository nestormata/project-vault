import { describe, expect, it } from 'vitest'
import { createLoggerConfig } from '../lib/logger.js'
import { redactBodyForLog } from '../plugins/redact-secrets.js'
import { createLogCaptureStream } from './helpers/capture-logs.js'

const REDACTED_VALUE = '[REDACTED]'
const RAW_PASSWORD = 'raw-password'
const RAW_PASSPHRASE = 'raw-passphrase'
const RAW_SECRET = 'raw-secret'
const RAW_CREDENTIAL_VALUE = 'raw-credential-value'
const RAW_RECOVERY_CODE = 'RAW-RECOVERY-CODE'
const RAW_TOTP = '123456'
const RAW_MASTER_KEY_PATH = '/run/secrets/raw-master-key'
const RAW_ENVELOPE_KEY_PATH = '/run/secrets/raw-envelope-key'
const RAW_REFRESH_TOKEN = 'raw-refresh-token'
const RAW_ACCESS_TOKEN = 'raw-access-token'
const RAW_CURRENT_PASSWORD = 'raw-current-password'
const RAW_NEW_PASSWORD = 'raw-new-password'
const TEST_REDACTION_EVENT_TYPE = 'test.redaction'
const REDACTION_TEST_MESSAGE = 'redaction test'

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
        eventType: TEST_REDACTION_EVENT_TYPE,
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
      REDACTION_TEST_MESSAGE
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
    expect(combined).toContain(REDACTED_VALUE)
  })

  it('redacts single-level structured secret fields used by route handler logs', () => {
    const { logger, lines } = capturedLogger()

    logger.info(
      {
        eventType: TEST_REDACTION_EVENT_TYPE,
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
      REDACTION_TEST_MESSAGE
    )

    const combined = lines.join('')
    expect(combined).not.toContain(RAW_CREDENTIAL_VALUE)
    expect(combined).toContain(REDACTED_VALUE)
  })

  it.each([
    [
      'vault',
      {
        passphrase: RAW_PASSPHRASE,
        masterKeyPath: RAW_MASTER_KEY_PATH,
        envelopeKeyPath: RAW_ENVELOPE_KEY_PATH,
        secret: RAW_SECRET,
        value: RAW_CREDENTIAL_VALUE,
      },
    ],
    [
      'auth/login',
      {
        password: RAW_PASSWORD,
        refreshToken: RAW_REFRESH_TOKEN,
        accessToken: RAW_ACCESS_TOKEN,
      },
    ],
    [
      'mfa',
      {
        totp: RAW_TOTP,
        recoveryCode: RAW_RECOVERY_CODE,
        currentPassword: RAW_CURRENT_PASSWORD,
        newPassword: RAW_NEW_PASSWORD,
      },
    ],
  ])(
    'redacts %s route-family sentinel values in Pino and manual body redaction',
    (_family, body) => {
      const { logger, lines } = capturedLogger()

      logger.info(
        {
          eventType: 'test.route_family_redaction',
          req: {
            headers: {
              authorization: 'Bearer raw-route-family-token',
              cookie: 'session=raw-route-family-cookie',
            },
            body,
          },
          body,
        },
        'route family redaction test'
      )

      const manual = JSON.stringify(redactBodyForLog(body))
      const combined = lines.join('')
      for (const value of Object.values(body)) {
        expect(combined).not.toContain(String(value))
        expect(manual).not.toContain(String(value))
      }
      expect(combined).not.toContain('raw-route-family-token')
      expect(combined).not.toContain('raw-route-family-cookie')
      expect(combined).toContain(REDACTED_VALUE)
      expect(manual).toContain(REDACTED_VALUE)
    }
  )

  // Story 28.9 AC-2 regression guard: a live request/response line carrying the export-key
  // response header must show [REDACTED], not the raw key. redact-paths.test.ts only asserts
  // `res.headers["x-export-key"]` is registered in `PINO_REDACT_PATHS` (static membership) —
  // this exercises the real Pino logger config the way the other cases above exercise
  // `req.body`/`req.headers`, so a future change to how response headers are constructed (this
  // app does not currently log them at all) can't silently reintroduce a live key leak with no
  // test to catch it.
  it('redacts X-Export-Key in a logged response-header-shaped line', () => {
    const { logger, lines } = capturedLogger()
    const RAW_EXPORT_KEY = 'raw-export-key-should-never-appear-in-logs'

    logger.info(
      {
        eventType: TEST_REDACTION_EVENT_TYPE,
        res: {
          headers: {
            'x-export-key': RAW_EXPORT_KEY,
          },
        },
      },
      REDACTION_TEST_MESSAGE
    )

    const combined = lines.join('')
    expect(combined).not.toContain(RAW_EXPORT_KEY)
    expect(combined).toContain(REDACTED_VALUE)
  })
})
