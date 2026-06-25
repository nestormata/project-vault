import { describe, it, expect, vi, afterEach } from 'vitest'
import { registerShutdown } from './shutdown.js'

vi.mock('../modules/vault/key-service.js', () => ({
  zeroKeys: vi.fn(),
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
    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
