import { describe, it, expect, vi, afterEach } from 'vitest'
import { OperationalEvent, SYSTEM_TRACE_ID } from '@project-vault/shared'
import { LOSING_ATTEMPT_DRAIN_TIMEOUT_MS, registerShutdown } from './shutdown.js'

vi.mock('../modules/vault/key-service.js', () => ({
  zeroKeys: vi.fn(),
}))

vi.mock('../modules/credential-shares/external-service.js', () => ({
  flushPendingLosingAttempts: vi.fn(async () => undefined),
}))

function makeFastify(closeImpl: () => Promise<unknown>) {
  return {
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    close: vi.fn(closeImpl),
  }
}

describe('registerShutdown', () => {
  const originalExit = process.exit
  const originalListeners = {
    SIGTERM: process.listeners('SIGTERM'),
    SIGINT: process.listeners('SIGINT'),
  }

  afterEach(() => {
    process.exit = originalExit
    process.removeAllListeners('SIGTERM')
    process.removeAllListeners('SIGINT')
    for (const listener of originalListeners.SIGTERM) process.on('SIGTERM', listener)
    for (const listener of originalListeners.SIGINT) process.on('SIGINT', listener)
    vi.clearAllMocks()
  })

  it('zeros keys before closing fastify on SIGTERM', async () => {
    const exitSpy = vi.fn()
    process.exit = exitSpy as never
    const { zeroKeys } = await import('../modules/vault/key-service.js')
    const callOrder: string[] = []
    vi.mocked(zeroKeys).mockImplementation(() => {
      callOrder.push('zeroKeys')
    })
    const fastify = makeFastify(async () => {
      callOrder.push('close')
    })

    registerShutdown(fastify as never)
    process.emit('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(callOrder).toEqual(['zeroKeys', 'close'])
    expect(fastify.log.info).toHaveBeenCalledWith(
      {
        eventType: OperationalEvent.SHUTDOWN_SIGNAL,
        traceId: SYSTEM_TRACE_ID,
        signal: 'SIGTERM',
      },
      'Received shutdown signal'
    )
    expect(fastify.log.info).toHaveBeenCalledWith(
      {
        eventType: OperationalEvent.SHUTDOWN_COMPLETE,
        traceId: SYSTEM_TRACE_ID,
      },
      'Shutdown complete'
    )
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('Story 65.4: drains pending deferred share writes, bounded, before zeroing keys', async () => {
    const exitSpy = vi.fn()
    process.exit = exitSpy as never
    const { zeroKeys } = await import('../modules/vault/key-service.js')
    const { flushPendingLosingAttempts } =
      await import('../modules/credential-shares/external-service.js')
    const callOrder: string[] = []
    vi.mocked(flushPendingLosingAttempts).mockImplementation(async () => {
      callOrder.push('flush')
    })
    vi.mocked(zeroKeys).mockImplementation(() => {
      callOrder.push('zeroKeys')
    })
    const fastify = makeFastify(async () => {
      callOrder.push('close')
    })

    registerShutdown(fastify as never)
    process.emit('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(callOrder).toEqual(['flush', 'zeroKeys', 'close'])
    expect(flushPendingLosingAttempts).toHaveBeenCalledWith(LOSING_ATTEMPT_DRAIN_TIMEOUT_MS)
    expect(exitSpy).toHaveBeenCalledWith(0)
  })

  it('still zeros keys and exits 1 if fastify.close() throws', async () => {
    const exitSpy = vi.fn()
    process.exit = exitSpy as never
    const { zeroKeys } = await import('../modules/vault/key-service.js')
    vi.mocked(zeroKeys).mockClear()
    const fastify = makeFastify(async () => {
      throw new Error('close failed')
    })

    registerShutdown(fastify as never)
    process.emit('SIGINT')
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(zeroKeys).toHaveBeenCalledTimes(2) // once before close, once in catch
    expect(fastify.log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: OperationalEvent.SHUTDOWN_FAILED,
        traceId: SYSTEM_TRACE_ID,
        err: expect.objectContaining({ message: 'close failed' }),
      }),
      'Shutdown failed'
    )
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
