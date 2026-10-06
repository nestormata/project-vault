import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  assertExtensionEmittersContained,
  checkBackgroundPromisesHandled,
  checkExtensionEmitters,
} from './conformance.js'

describe('checkExtensionEmitters', () => {
  it('fails an emitter that has no error listener (the pg.Pool-without-listener class)', () => {
    const pool = new EventEmitter()
    const result = checkExtensionEmitters({ controlPlanePool: pool })
    expect(result.ok).toBe(false)
    expect(result.violations).toEqual(['controlPlanePool'])
  })

  it('passes an emitter that carries an error listener, and does not throw while forcing', () => {
    const pool = new EventEmitter()
    const seen: string[] = []
    pool.on('error', (err: Error) => seen.push(err.name))
    const result = checkExtensionEmitters({ controlPlanePool: pool })
    expect(result).toEqual({ ok: true, violations: [] })
    expect(seen).toEqual(['Error'])
  })

  it('reports every offending label and keeps the conforming ones out', () => {
    const good = new EventEmitter()
    good.on('error', () => undefined)
    const result = checkExtensionEmitters({ a: new EventEmitter(), good, b: new EventEmitter() })
    expect(result.violations).toEqual(['a', 'b'])
  })

  it('never puts error text in the violation output', () => {
    const result = checkExtensionEmitters({ pool: new EventEmitter() })
    expect(JSON.stringify(result)).not.toContain('postgres://')
  })
})

describe('assertExtensionEmittersContained', () => {
  it('throws naming only the offending labels', () => {
    expect(() => assertExtensionEmittersContained({ leaky: new EventEmitter() })).toThrow(/leaky/)
  })

  it('returns quietly when every emitter is covered', () => {
    const ok = new EventEmitter()
    ok.on('error', () => undefined)
    expect(() => assertExtensionEmittersContained({ ok })).not.toThrow()
  })
})

describe('checkBackgroundPromisesHandled', () => {
  it('flags a background promise that rejects with no handler', async () => {
    const result = await checkBackgroundPromisesHandled(() => {
      void Promise.reject(new Error('boom'))
    })
    expect(result).toEqual({ ok: false, unhandledCount: 1 })
  })

  it('passes when the rejection is handled', async () => {
    const result = await checkBackgroundPromisesHandled(async () => {
      await Promise.reject(new Error('boom')).catch(() => undefined)
    })
    expect(result).toEqual({ ok: true, unhandledCount: 0 })
  })

  it('removes its listener afterwards', async () => {
    const before = process.listenerCount('unhandledRejection')
    await checkBackgroundPromisesHandled(() => undefined)
    expect(process.listenerCount('unhandledRejection')).toBe(before)
  })
})
