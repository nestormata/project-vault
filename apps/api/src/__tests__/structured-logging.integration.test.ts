import { describe, expect, it } from 'vitest'
import { OperationalEvent } from '@project-vault/shared'
import { createApp } from '../app.js'
import { createLoggerConfig } from '../lib/logger.js'
import { createLogCaptureStream } from './helpers/capture-logs.js'

function testLogger(stream: NodeJS.WritableStream): object {
  return {
    ...createLoggerConfig({ NODE_ENV: 'development', LOG_LEVEL: 'info', SERVICE_NAME: 'api' }),
    stream,
  }
}

async function flushLogger(logger: unknown): Promise<void> {
  await (logger as { flush?: () => void | Promise<void> }).flush?.()
}

function parseLogLines(lines: string[]): Array<Record<string, unknown>> {
  return lines
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe.sequential('Story 1.10 structured logging', () => {
  it('emits a structured http.request log with required FR82 fields', async () => {
    const { stream, lines } = createLogCaptureStream()
    const requestId = ['550e8400', 'e29b', '41d4', 'a716', '446655440000'].join('-')
    const app = await createApp({
      logger: testLogger(stream),
    })

    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': requestId },
    })
    await flushLogger(app.log)

    expect(response.statusCode).toBe(200)
    expect(response.headers['x-request-id']).toBe(requestId)

    const parsed = parseLogLines(lines)
    const requestLogs = parsed.filter((line) => line.eventType === OperationalEvent.HTTP_REQUEST)
    expect(requestLogs).toHaveLength(1)
    expect(requestLogs[0]).toMatchObject({
      level: 'info',
      service: 'api',
      traceId: requestId,
      eventType: OperationalEvent.HTTP_REQUEST,
      message: 'request completed',
      method: 'GET',
      url: '/health',
      statusCode: 200,
    })
    expect(requestLogs[0]?.timestamp).toEqual(expect.any(String))
    expect(requestLogs[0]?.responseTimeMs).toEqual(expect.any(Number))
    expect(parsed).not.toContainEqual(expect.objectContaining({ eventType: 'system.untyped' }))

    await app.close()
  })

  it('generates a fresh traceId when X-Request-ID is not a UUID v4 value', async () => {
    const { stream, lines } = createLogCaptureStream()
    const app = await createApp({
      logger: testLogger(stream),
    })

    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'not-a-valid-request-id' },
    })
    await flushLogger(app.log)

    expect(response.statusCode).toBe(200)
    expect(response.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
    expect(response.headers['x-request-id']).not.toBe('not-a-valid-request-id')

    const [requestLog] = parseLogLines(lines).filter(
      (line) => line.eventType === OperationalEvent.HTTP_REQUEST
    )
    expect(requestLog?.traceId).toBe(response.headers['x-request-id'])

    await app.close()
  })

  it('keeps unexpected request error logs in the FR82 schema', async () => {
    const { stream, lines } = createLogCaptureStream()
    const app = await createApp({
      logger: testLogger(stream),
    })
    app.get('/boom', async () => {
      throw new Error('boom')
    })

    const response = await app.inject({ method: 'GET', url: '/boom' })
    await flushLogger(app.log)

    expect(response.statusCode).toBe(500)
    const parsed = parseLogLines(lines)
    const errorLogs = parsed.filter((line) => line.level === 'error')
    expect(errorLogs).toContainEqual(
      expect.objectContaining({
        traceId: expect.any(String),
        eventType: expect.not.stringMatching(/^system\.untyped$/),
        message: 'Unhandled request error',
      })
    )

    await app.close()
  })
})
