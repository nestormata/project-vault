import { describe, expect, it } from 'vitest'
import { SYSTEM_TRACE_ID } from '@project-vault/shared'
import { createLogCaptureStream } from '../__tests__/helpers/capture-logs.js'
import {
  createEntrypointLoggerConfig,
  createLoggerConfig,
  EMAIL_REDACTION_PLACEHOLDER,
  operationalLog,
  serializeLogError,
} from './logger.js'
import type { Env } from '../config/env.js'
import type { FastifyBaseLogger } from 'fastify'

function baseEnv(
  overrides: Partial<Env> = {}
): Pick<Env, 'NODE_ENV' | 'LOG_LEVEL' | 'SERVICE_NAME'> {
  return {
    NODE_ENV: 'development',
    LOG_LEVEL: 'info',
    SERVICE_NAME: 'api',
    ...overrides,
  } as Pick<Env, 'NODE_ENV' | 'LOG_LEVEL' | 'SERVICE_NAME'>
}

describe('createLoggerConfig', () => {
  it('returns a plain options object with the configured level when no destination is given', () => {
    const config = createLoggerConfig(baseEnv({ LOG_LEVEL: 'warn' }))
    expect(config).toMatchObject({ level: 'warn', messageKey: 'message' })
  })

  it('forces level to silent in NODE_ENV=test when no destination is given', () => {
    const config = createLoggerConfig(baseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'info' }))
    expect(config).toMatchObject({ level: 'silent' })
  })

  it('honors LOG_LEVEL (not silent) in NODE_ENV=test when a destination is provided', () => {
    const { stream } = createLogCaptureStream()
    const logger = createLoggerConfig(baseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'info' }), stream)
    expect(logger.level).toBe('info')
  })

  // Story 66.4 AC-3: the real process entrypoint (main.ts) honours an explicit LOG_LEVEL even
  // under NODE_ENV=test; in-process tests (the no-destination default above) stay silent.
  it.each(['info', 'debug', 'silent'] as const)(
    'createEntrypointLoggerConfig honours LOG_LEVEL=%s under NODE_ENV=test',
    (level) => {
      const config = createEntrypointLoggerConfig(baseEnv({ NODE_ENV: 'test', LOG_LEVEL: level }))
      expect(config).toMatchObject({ level, messageKey: 'message', base: { service: 'api' } })
    }
  )

  it('emits the service field on every log line', () => {
    const { stream, lines } = createLogCaptureStream()
    const logger = createLoggerConfig(baseEnv({ SERVICE_NAME: 'my-svc' }), stream)
    logger.info({ eventType: 'test.event' }, 'hello')
    const parsed = JSON.parse(lines[0] ?? '{}')
    expect(parsed.service).toBe('my-svc')
    expect(parsed.message).toBe('hello')
  })

  it('defaults the mixin eventType to system.untyped when caller omits it', () => {
    const { stream, lines } = createLogCaptureStream()
    const logger = createLoggerConfig(baseEnv(), stream)
    logger.info('no eventType passed')
    const parsed = JSON.parse(lines[0] ?? '{}')
    expect(parsed.eventType).toBe('system.untyped')
  })

  it('lets caller-provided eventType override the mixin default', () => {
    const { stream, lines } = createLogCaptureStream()
    const logger = createLoggerConfig(baseEnv(), stream)
    logger.info({ eventType: 'custom.event' }, 'overridden')
    const parsed = JSON.parse(lines[0] ?? '{}')
    expect(parsed.eventType).toBe('custom.event')
  })
})

describe('serializeLogError', () => {
  it('redacts connection-string userinfo from error messages and stacks', () => {
    const error = new Error(
      'connect failed for postgresql://vault_admin:super-secret@example.invalid:5432/project_vault'
    )
    error.stack = `${error.stack}\npostgresql://vault_admin:super-secret@example.invalid:5432/project_vault`

    const serialized = serializeLogError(error)
    expect(serialized.message).not.toContain('super-secret')
    expect(serialized.stack).not.toContain('super-secret')
    expect(serialized.message).toContain('[REDACTED]')
    expect(serialized.stack).toContain('[REDACTED]')
  })

  it('redacts user-only and multi-colon userinfo, and leaves credential-free URLs alone', () => {
    const serialized = serializeLogError(
      new Error('a redis://only-user@h b://u:p:q@h https://example.invalid/path')
    )
    expect(serialized.message).toBe(
      'a redis://[REDACTED]@h b://[REDACTED]@h https://example.invalid/path'
    )
  })

  it('scans a long scheme-prefixed message without "@" in linear time (no ReDoS)', () => {
    const started = performance.now()
    const serialized = serializeLogError(new Error(`postgresql://${'a'.repeat(100_000)}`))
    expect(performance.now() - started).toBeLessThan(1000)
    expect(serialized.message).toHaveLength('postgresql://'.length + 100_000)
  })

  it('redacts connection-string userinfo that is itself an email address', () => {
    const serialized = serializeLogError(
      new Error('smtp://jordan@example.com:s3cret@mail.example.com failed')
    )
    expect(serialized.message).toBe('smtp://[REDACTED]@mail.example.com failed')
  })
})

describe('serializeLogError email redaction (70-4)', () => {
  const P = EMAIL_REDACTION_PLACEHOLDER

  it('uses the fixed placeholder', () => {
    expect(P).toBe('[REDACTED_EMAIL]')
  })

  it.each([
    ['Recipient address rejected: <jordan@example.com>', `Recipient address rejected: <${P}>`],
    ["jordan@example.com and sam.o'neil+tag@mail.example.co.uk", `${P} and ${P}`],
    ['a@b.com a@b.com a@b.com', `${P} ${P} ${P}`],
    ['用户@例子.com and jörg@exämple.de', `${P} and ${P}`],
    ['sent to jordan@example.com.', `sent to ${P}.`],
    ['Jordan@Example.COM', P],
    [
      'smtp://u:p@mail.example.com failed for a@b.com',
      `smtp://[REDACTED]@mail.example.com failed for ${P}`,
    ],
  ])('masks addresses in message and stack: %s', (input, expected) => {
    const error = new Error(input)
    error.stack = `Error: ${input}\n    at frame (${input})`
    const serialized = serializeLogError(error)
    expect(serialized.message).toBe(expected)
    expect(serialized.stack).toBe(`Error: ${expected}\n    at frame (${expected})`)
  })

  it.each([
    'Connection refused',
    'ECONNRESET 10.0.0.5:5432',
    'postgres@localhost',
    'user@host',
    '@mention',
    'a @ b',
    '12:30@5',
    'at /app/node_modules/.pnpm/pg-pool@3.6.1/node_modules/pg-pool/index.js:45',
    'file:///app/node_modules/pkg@1.2.3-4/x.js',
  ])('leaves non-addresses untouched: %s', (input) => {
    expect(serializeLogError(new Error(input)).message).toBe(input)
  })

  it('still yields an empty message for new Error()', () => {
    expect(serializeLogError(new Error()).message).toBe('')
  })

  it('masks addresses in non-Error thrown values', () => {
    expect(serializeLogError('550 jordan@example.com unknown')).toEqual({
      message: `550 ${P} unknown`,
    })
    const thrown = { toString: () => 'bad jordan@example.com' }
    expect(serializeLogError(thrown)).toEqual({ message: `bad ${P}` })
  })

  it.each([
    ['no @ run', 'a'.repeat(100_000), 'a'.repeat(100_000)],
    ['repeated a@', 'a@'.repeat(50_000), 'a@'.repeat(50_000)],
    ['dotted run then @b', `${'a.'.repeat(50_000)}@b`, `${'a.'.repeat(50_000)}@b`],
    ['only @', '@'.repeat(100_000), '@'.repeat(100_000)],
    ['long local then address', `${'a'.repeat(100_000)}@b.c`, P],
  ])('matches in linear time on adversarial input: %s', (_name, input, expected) => {
    const started = performance.now()
    const serialized = serializeLogError(new Error(input))
    expect(performance.now() - started).toBeLessThan(1000)
    expect(serialized.message).toBe(expected)
    if (expected === P) expect(serialized.message).toHaveLength(P.length)
  })
})

describe('operationalLog', () => {
  it('always injects SYSTEM_TRACE_ID, even if a caller tries to pass traceId in fields', () => {
    const calls: Array<[unknown, string]> = []
    const logger = {
      info: (payload: unknown, message: string) => {
        calls.push([payload, message])
      },
      warn: () => undefined,
      error: () => undefined,
    } as unknown as Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>

    operationalLog(logger, 'info', 'startup.complete', 'API startup complete', {
      traceId: 'attacker-supplied-value',
      port: 3000,
    })

    expect(calls).toHaveLength(1)
    const [payload, message] = calls[0] as [Record<string, unknown>, string]
    expect(payload.traceId).toBe(SYSTEM_TRACE_ID)
    expect(payload.eventType).toBe('startup.complete')
    expect(payload.port).toBe(3000)
    expect(message).toBe('API startup complete')
  })

  it('Story 14.2: supports fatal-equivalent severity for boot-time fail-safe logging', () => {
    const calls: Array<[unknown, string]> = []
    const logger = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      fatal: (payload: unknown, message: string) => {
        calls.push([payload, message])
      },
    } as unknown as Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'fatal'>

    operationalLog(logger, 'fatal', 'extension.load_failed', 'extension failed to load', {
      reason: 'import_error',
    })

    expect(calls).toHaveLength(1)
    const [payload, message] = calls[0] as [Record<string, unknown>, string]
    expect(payload.eventType).toBe('extension.load_failed')
    expect(payload.reason).toBe('import_error')
    expect(message).toBe('extension failed to load')
  })
})
