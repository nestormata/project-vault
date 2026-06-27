import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { SYSTEM_TRACE_ID } from '@project-vault/shared'
import { createLoggerConfig, operationalLog } from './logger.js'
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

function captureStream(): { stream: Writable; lines: string[] } {
  const lines: string[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString())
      cb()
    },
  })
  return { stream, lines }
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
    const { stream } = captureStream()
    const logger = createLoggerConfig(baseEnv({ NODE_ENV: 'test', LOG_LEVEL: 'info' }), stream)
    expect(logger.level).toBe('info')
  })

  it('emits the service field on every log line', () => {
    const { stream, lines } = captureStream()
    const logger = createLoggerConfig(baseEnv({ SERVICE_NAME: 'my-svc' }), stream)
    logger.info({ eventType: 'test.event' }, 'hello')
    const parsed = JSON.parse(lines[0] ?? '{}')
    expect(parsed.service).toBe('my-svc')
    expect(parsed.message).toBe('hello')
  })

  it('defaults the mixin eventType to system.untyped when caller omits it', () => {
    const { stream, lines } = captureStream()
    const logger = createLoggerConfig(baseEnv(), stream)
    logger.info('no eventType passed')
    const parsed = JSON.parse(lines[0] ?? '{}')
    expect(parsed.eventType).toBe('system.untyped')
  })

  it('lets caller-provided eventType override the mixin default', () => {
    const { stream, lines } = captureStream()
    const logger = createLoggerConfig(baseEnv(), stream)
    logger.info({ eventType: 'custom.event' }, 'overridden')
    const parsed = JSON.parse(lines[0] ?? '{}')
    expect(parsed.eventType).toBe('custom.event')
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
})
