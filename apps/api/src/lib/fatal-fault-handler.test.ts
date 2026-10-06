import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OperationalEvent, SYSTEM_TRACE_ID } from '@project-vault/shared'
import { registerFatalFaultHandler } from './fatal-fault-handler.js'

const SECRET_URL = 'postgres://cm_admin:hunter2-s3cret@cm-db.internal:5432/control_plane'
const EXTENSION_PACKAGE = '@acme/pack'
const EXTENSION_NAME = 'com.acme.module-pack'

type FaultListener = (error: unknown, origin?: string) => void

function makeHarness(overrides: Partial<Parameters<typeof registerFatalFaultHandler>[0]> = {}) {
  const calls: string[] = []
  const log = {
    fatal: vi.fn((..._args: unknown[]) => void calls.push('log')),
    error: vi.fn(),
  }
  const exit = vi.fn((_code: number) => void calls.push('exit'))
  const zeroKeys = vi.fn(() => void calls.push('zeroKeys'))
  const close = vi.fn(async () => void calls.push('close'))
  const beforeUnc = new Set(process.listeners('uncaughtException'))
  const beforeRej = new Set(process.listeners('unhandledRejection'))
  const uninstall = registerFatalFaultHandler({
    getLogger: () => log,
    getExtensionPackage: () => EXTENSION_PACKAGE,
    getExtensionName: () => EXTENSION_NAME,
    close,
    zeroKeys,
    exit: exit as never,
    ...overrides,
  })
  const ours = (event: 'uncaughtException' | 'unhandledRejection') => {
    const before = event === 'uncaughtException' ? beforeUnc : beforeRej
    const added = process.listeners(event).filter((l) => !before.has(l))
    return added as unknown as FaultListener[]
  }
  /** Fires the handler this registration added, the way Node would, and awaits its exit path. */
  const fire = (event: 'uncaughtException' | 'unhandledRejection', error: unknown) => {
    const [listener] = ours(event)
    if (!listener) throw new Error(`no ${event} listener registered`)
    return Promise.resolve(listener(error, event))
  }
  const firstFatal = (): Record<string, unknown> => {
    const [payload] = log.fatal.mock.calls[0] ?? []
    return (payload ?? {}) as Record<string, unknown>
  }
  return { calls, log, exit, zeroKeys, close, uninstall, ours, fire, firstFatal }
}

function loggedText(log: { fatal: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }) {
  return JSON.stringify([log.fatal.mock.calls, log.error.mock.calls])
}

describe('registerFatalFaultHandler', () => {
  let uninstall: (() => void) | undefined

  afterEach(() => {
    uninstall?.()
    uninstall = undefined
    vi.useRealTimers()
  })

  it('registers one uncaughtException and one unhandledRejection listener and removes them again', () => {
    const h = makeHarness()
    uninstall = h.uninstall
    expect(h.ours('uncaughtException')).toHaveLength(1)
    expect(h.ours('unhandledRejection')).toHaveLength(1)
    h.uninstall()
    expect(h.ours('uncaughtException')).toHaveLength(0)
    expect(h.ours('unhandledRejection')).toHaveLength(0)
  })

  it('zeroes keys first, logs, closes, then exits non-zero (never resumes serving)', async () => {
    const h = makeHarness()
    uninstall = h.uninstall
    await h.fire('uncaughtException', new TypeError('boom'))
    expect(h.calls).toEqual(['zeroKeys', 'log', 'close', 'exit'])
    expect(h.exit).toHaveBeenCalledTimes(1)
    expect(h.exit).toHaveBeenCalledWith(1)
  })

  it('treats an unhandled rejection through the same exit path', async () => {
    const h = makeHarness()
    uninstall = h.uninstall
    await h.fire('unhandledRejection', new RangeError('late'))
    expect(h.calls).toEqual(['zeroKeys', 'log', 'close', 'exit'])
    expect(h.exit).toHaveBeenCalledWith(1)
    expect(h.firstFatal()).toMatchObject({
      eventType: OperationalEvent.PROCESS_FATAL_FAULT,
      origin: 'unhandledRejection',
      errorName: 'RangeError',
    })
  })

  it('catches a listener-less emitter error the way Node surfaces it (extension-style pool)', async () => {
    const h = makeHarness()
    uninstall = h.uninstall
    const pool = new EventEmitter()
    let surfaced: unknown
    try {
      pool.emit('error', new Error(`connect failed ${SECRET_URL}`))
    } catch (err) {
      surfaced = err
    }
    await h.fire('uncaughtException', surfaced)
    expect(h.exit).toHaveBeenCalledWith(1)
    expect(h.zeroKeys).toHaveBeenCalledTimes(1)
  })

  it('emits a structured fatal event with only the safe fields', async () => {
    const h = makeHarness()
    uninstall = h.uninstall
    await h.fire('uncaughtException', new Error('x'))
    expect(h.log.fatal).toHaveBeenCalledTimes(1)
    const message = h.log.fatal.mock.calls[0]?.[1]
    expect(h.firstFatal()).toEqual({
      eventType: OperationalEvent.PROCESS_FATAL_FAULT,
      traceId: SYSTEM_TRACE_ID,
      origin: 'uncaughtException',
      errorName: 'Error',
      attribution: 'unattributed',
      extension: null,
    })
    expect(typeof message).toBe('string')
  })

  it('attributes to the extension only when the stack names its package path', async () => {
    const h = makeHarness()
    uninstall = h.uninstall
    const err = new Error('pool down')
    err.stack = `Error: pool down\n    at Pool.emit (node:events:1)\n    at X (/srv/app/node_modules/${EXTENSION_PACKAGE}/dist/pool.js:10:5)`
    await h.fire('uncaughtException', err)
    expect(h.firstFatal()).toMatchObject({
      attribution: 'extension',
      extension: EXTENSION_NAME,
    })
  })

  it('attributes a pnpm-layout stack path too, and never a look-alike package', async () => {
    const pnpm = makeHarness()
    const err = new Error('x')
    err.stack =
      'Error: x\n    at f (/srv/node_modules/.pnpm/@acme+pack@1.2.3/node_modules/@acme/pack/dist/a.js:1:1)'
    await pnpm.fire('uncaughtException', err)
    expect(pnpm.firstFatal()).toMatchObject({ attribution: 'extension' })
    pnpm.uninstall()

    const lookalike = makeHarness()
    uninstall = lookalike.uninstall
    const other = new Error('x')
    other.stack = 'Error: x\n    at f (/srv/node_modules/@acme/pack-evil/dist/a.js:1:1)'
    await lookalike.fire('uncaughtException', other)
    expect(lookalike.firstFatal()).toMatchObject({
      attribution: 'unattributed',
      extension: null,
    })
  })

  it('attribution never changes the exit decision', async () => {
    const h = makeHarness()
    uninstall = h.uninstall
    const err = new Error('x')
    err.stack = `Error: x\n    at f (/srv/node_modules/${EXTENSION_PACKAGE}/a.js:1:1)`
    await h.fire('uncaughtException', err)
    expect(h.exit).toHaveBeenCalledWith(1)
  })

  it('never logs the error message, stack text or a connection string', async () => {
    const h = makeHarness()
    uninstall = h.uninstall
    const err = new Error(`connect failed ${SECRET_URL}`)
    err.stack = `Error: connect failed ${SECRET_URL}\n    at f (/srv/node_modules/${EXTENSION_PACKAGE}/a.js:1:1)`
    ;(err as Error & { detail: string }).detail = SECRET_URL
    await h.fire('uncaughtException', err)
    const text = loggedText(h.log)
    expect(text).not.toContain('hunter2')
    expect(text).not.toContain('s3cret')
    expect(text).not.toContain('postgres://')
    expect(text).not.toContain('connect failed')
    expect(text).toContain('Error')
  })

  it('does not echo a non-Error rejection reason', async () => {
    const h = makeHarness()
    uninstall = h.uninstall
    await h.fire('unhandledRejection', SECRET_URL)
    expect(loggedText(h.log)).not.toContain('s3cret')
    expect(h.firstFatal()).toMatchObject({ errorName: 'NonError' })
  })

  it('logs a syscall-style error code only when it matches the allow-list shape', async () => {
    const h = makeHarness()
    uninstall = h.uninstall
    const ok = Object.assign(new Error('x'), { code: 'ECONNREFUSED' })
    await h.fire('uncaughtException', ok)
    expect(h.firstFatal()).toMatchObject({ errorCode: 'ECONNREFUSED' })

    h.uninstall()
    const second = makeHarness()
    uninstall = second.uninstall
    const bad = Object.assign(new Error('x'), { code: `bad ${SECRET_URL}` })
    await second.fire('uncaughtException', bad)
    expect(second.firstFatal()).not.toHaveProperty('errorCode')
    expect(loggedText(second.log)).not.toContain('s3cret')
  })

  it('is once-only: a second fault during the exit path exits immediately without relogging', async () => {
    let releaseClose: () => void = () => undefined
    const h = makeHarness({
      close: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseClose = resolve
          })
      ),
    })
    uninstall = h.uninstall
    const first = h.fire('uncaughtException', new Error('one'))
    await Promise.resolve()
    await h.fire('unhandledRejection', new Error('two'))
    expect(h.exit).toHaveBeenCalledWith(1)
    expect(h.log.fatal).toHaveBeenCalledTimes(1)
    expect(h.zeroKeys).toHaveBeenCalledTimes(1)
    releaseClose()
    await first
  })

  it('force-exits non-zero when closing the server hangs past the bound', async () => {
    vi.useFakeTimers()
    const h = makeHarness({
      close: vi.fn(() => new Promise<void>(() => undefined)),
      closeTimeoutMs: 50,
    })
    uninstall = h.uninstall
    const run = h.fire('uncaughtException', new Error('x'))
    await vi.advanceTimersByTimeAsync(60)
    await run
    expect(h.exit).toHaveBeenCalledTimes(1)
    expect(h.exit).toHaveBeenCalledWith(1)
  })

  it('falls back to exit(1) after zeroing keys when the logger itself throws', async () => {
    const h = makeHarness({
      getLogger: () => ({
        fatal: () => {
          throw new Error('logger broken')
        },
      }),
    })
    uninstall = h.uninstall
    await h.fire('uncaughtException', new Error('x'))
    expect(h.zeroKeys).toHaveBeenCalled()
    expect(h.exit).toHaveBeenCalledWith(1)
  })

  it('still exits when zeroKeys throws, and when close rejects', async () => {
    const h = makeHarness({
      zeroKeys: () => {
        throw new Error('zero failed')
      },
      close: vi.fn(async () => {
        throw new Error('close failed')
      }),
    })
    uninstall = h.uninstall
    await h.fire('uncaughtException', new Error('x'))
    expect(h.exit).toHaveBeenCalledWith(1)
    expect(h.exit.mock.calls.every(([code]) => code === 1)).toBe(true)
  })

  it('uses process.exit by default and never resolves to a continue-serving state', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const before = new Set(process.listeners('uncaughtException'))
    const off = registerFatalFaultHandler({
      getLogger: () => ({ fatal: vi.fn() }),
      getExtensionPackage: () => undefined,
      getExtensionName: () => undefined,
      zeroKeys: vi.fn(),
    })
    uninstall = off
    const [ours] = process.listeners('uncaughtException').filter((l) => !before.has(l))
    await (ours as unknown as FaultListener)(new Error('x'), 'uncaughtException')
    expect(exitSpy).toHaveBeenCalledWith(1)
    exitSpy.mockRestore()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })
})

describe('boot wiring (main.ts)', () => {
  // Vite inlines the text at transform time (no filesystem path is built by the test).
  const sources: Record<string, unknown> = import.meta.glob(['../main.ts'], {
    query: '?raw',
    import: 'default',
    eager: true,
  })
  const mainSource = Object.values(sources).map(String).join('')

  it('installs the fatal fault handler before createApp(), which is where loadExtension() runs', () => {
    const install = mainSource.indexOf('registerFatalFaultHandler(')
    const createApp = mainSource.indexOf('await createApp(')
    expect(install).toBeGreaterThan(-1)
    expect(createApp).toBeGreaterThan(-1)
    expect(install).toBeLessThan(createApp)
  })

  it('does not install any continue-serving process handler outside the fatal handler', () => {
    expect(mainSource).not.toMatch(/process\.on\(\s*['"](uncaughtException|unhandledRejection)/)
  })
})
