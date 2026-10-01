import { Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OperationalEvent, SYSTEM_TRACE_ID } from '@project-vault/shared'
import type { Env } from '../config/env.js'
import { createLogCaptureStream, parseCapturedLogLines } from '../__tests__/helpers/capture-logs.js'
import { logStartupFailure, reportStartupFailure, stderrDestination } from './startup-logging.js'

type StartupEnv = Pick<Env, 'NODE_ENV' | 'LOG_LEVEL' | 'SERVICE_NAME'>

function startupEnv(nodeEnv: Env['NODE_ENV'], logLevel: Env['LOG_LEVEL']): StartupEnv {
  return { NODE_ENV: nodeEnv, LOG_LEVEL: logLevel, SERVICE_NAME: 'api' } as StartupEnv
}

describe('logStartupFailure', () => {
  it('emits a structured startup.failed log and flushes before exit handling', async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    }
    const err = new Error('listen failed')

    await logStartupFailure(logger, err)

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: OperationalEvent.STARTUP_FAILED,
        traceId: SYSTEM_TRACE_ID,
        err: expect.objectContaining({ message: 'listen failed' }),
      }),
      'API startup failed'
    )
    expect(logger.flush).toHaveBeenCalledOnce()
  })
})

// Story 66.4 AC-2: a process that refuses to start must say why on a stream no LOG_LEVEL or
// NODE_ENV can silence.
describe('reportStartupFailure', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const combinations: Array<[Env['NODE_ENV'], Env['LOG_LEVEL']]> = [
    ...(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const).flatMap((level) =>
      (['test', 'development'] as const).map(
        (nodeEnv) => [nodeEnv, level] as [Env['NODE_ENV'], Env['LOG_LEVEL']]
      )
    ),
    ...(['silent', 'fatal', 'error', 'warn', 'info'] as const).map(
      (level) => ['production', level] as [Env['NODE_ENV'], Env['LOG_LEVEL']]
    ),
  ]

  it.each(combinations)(
    'writes exactly one startup.failed line under NODE_ENV=%s LOG_LEVEL=%s',
    async (nodeEnv, logLevel) => {
      const { stream, lines } = createLogCaptureStream()

      await reportStartupFailure(startupEnv(nodeEnv, logLevel), new Error('boot broke'), stream)

      const parsed = parseCapturedLogLines(lines)
      expect(parsed).toHaveLength(1)
      expect(parsed[0]).toMatchObject({
        level: 'error',
        eventType: OperationalEvent.STARTUP_FAILED,
        message: 'API startup failed',
        traceId: SYSTEM_TRACE_ID,
        service: 'api',
        err: { name: 'Error', message: 'boot broke' },
      })
      expect(typeof (parsed[0]?.['err'] as { stack?: unknown }).stack).toBe('string')
    }
  )

  it('redacts a DSN credential in the message and stack from the written bytes', async () => {
    const { stream, lines } = createLogCaptureStream()
    const err = new Error('connect failed postgresql://vault_admin:e2e-sentinel-9f3c@db:5432/x')

    await reportStartupFailure(startupEnv('test', 'silent'), err, stream)

    const bytes = lines.join('')
    expect(bytes).not.toContain('e2e-sentinel-9f3c')
    const parsed = parseCapturedLogLines(lines)
    expect((parsed[0]?.['err'] as { message: string }).message).toBe(
      'connect failed postgresql://[REDACTED]@db:5432/x'
    )
  })

  it('serializes a non-Error throw', async () => {
    const { stream, lines } = createLogCaptureStream()

    await reportStartupFailure(startupEnv('test', 'silent'), 'boom', stream)

    expect(parseCapturedLogLines(lines)[0]?.['err']).toMatchObject({ message: 'boom' })
  })

  it('serializes a thrown value whose String() throws', async () => {
    const { stream, lines } = createLogCaptureStream()
    const hostile = {
      toString() {
        throw new Error('nope')
      },
    }

    await reportStartupFailure(startupEnv('test', 'silent'), hostile, stream)

    expect(parseCapturedLogLines(lines)[0]?.['err']).toMatchObject({
      message: 'Unable to serialize thrown value',
    })
  })

  it('falls back to a plain redacted Fatal error line when the structured write throws', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const broken = new Writable({
      write() {
        throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
      },
    })

    await expect(
      reportStartupFailure(
        startupEnv('production', 'info'),
        new Error('bad postgresql://u:e2e-sentinel-9f3c@h/d'),
        broken
      )
    ).resolves.toBeUndefined()

    expect(stderrWrite).toHaveBeenCalledOnce()
    const written = String(stderrWrite.mock.calls[0]?.[0])
    expect(written).toBe('Fatal error: bad postgresql://[REDACTED]@h/d\n')
  })

  it('still resolves when both the structured write and the fallback write throw', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      throw new Error('stderr closed')
    })
    const broken = new Writable({
      write() {
        throw new Error('write EPIPE')
      },
    })

    await expect(
      reportStartupFailure(startupEnv('test', 'silent'), new Error('x'), broken)
    ).resolves.toBeUndefined()
  })
})

describe('stderrDestination', () => {
  it('is a synchronous destination on fd 2', () => {
    const destination = stderrDestination() as unknown as { fd: number; sync: boolean }
    expect(destination.fd).toBe(2)
    expect(destination.sync).toBe(true)
  })
})
