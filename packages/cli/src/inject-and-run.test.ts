import { EventEmitter } from 'node:events'
import { VaultAgentError } from '@project-vault/agent'
import { describe, expect, it, vi } from 'vitest'
import { EXIT_CODES } from './exit-codes.js'
import { injectAndRun, type ChildProcessLike, type ParentProcessLike } from './inject-and-run.js'

/** A controllable fake child-process-like emitter (AC-4's own testing guidance: inject a fake
 * spawn dependency that returns a controllable fake child-process-like emitter). */
function makeFakeChild(): ChildProcessLike & {
  emitExit: (code: number | null, signal: NodeJS.Signals | null) => void
  emitError: (error: Error) => void
  kill: ReturnType<typeof vi.fn>
} {
  const emitter = new EventEmitter()
  const kill = vi.fn().mockReturnValue(true)
  return {
    on: (event, listener) => {
      emitter.on(event, listener)
    },
    kill,
    emitExit: (code, signal) => emitter.emit('exit', code, signal),
    emitError: (error) => emitter.emit('error', error),
  }
}

function makeFakeParentProcess(platform: NodeJS.Platform = 'linux'): ParentProcessLike & {
  killCalls: Array<[number, NodeJS.Signals]>
  sigintListeners: Array<() => void>
} {
  const sigintListeners: Array<() => void> = []
  const killCalls: Array<[number, NodeJS.Signals]> = []
  return {
    pid: 12345,
    platform,
    on: (event, listener) => {
      if (event === 'SIGINT') sigintListeners.push(listener)
    },
    removeListener: (event, listener) => {
      if (event === 'SIGINT') {
        const idx = sigintListeners.indexOf(listener)
        if (idx !== -1) sigintListeners.splice(idx, 1)
      }
    },
    kill: (pid, signal) => {
      killCalls.push([pid, signal])
    },
    killCalls,
    sigintListeners,
  }
}

describe('injectAndRun — AC-1: fetch and inject', () => {
  it('fetches a single secret and spawns the command with it injected into env, layered on baseEnv', async () => {
    const fakeChild = makeFakeChild()
    const spawn = vi.fn().mockReturnValue(fakeChild)
    const getSecret = vi.fn().mockResolvedValue('super-secret-value')
    const parentProcess = makeFakeParentProcess()

    const resultPromise = injectAndRun(
      [{ credentialName: 'DATABASE_URL', envVarName: 'DATABASE_URL' }],
      'psql',
      ['-c', 'select 1'],
      { getSecret, spawn, parentProcess, baseEnv: { EXISTING: 'x' } }
    )

    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    fakeChild.emitExit(0, null)
    const result = await resultPromise

    expect(getSecret).toHaveBeenCalledWith('DATABASE_URL')
    expect(spawn).toHaveBeenCalledWith('psql', ['-c', 'select 1'], {
      env: { EXISTING: 'x', DATABASE_URL: 'super-secret-value' },
      stdio: 'inherit',
    })
    expect(result).toEqual({ ok: true, exitCode: 0 })
  })

  it('injects multiple secrets, sequentially, each under its own env var name', async () => {
    const fakeChild = makeFakeChild()
    const spawn = vi.fn().mockReturnValue(fakeChild)
    const getSecret = vi
      .fn()
      .mockImplementation((name: string) => Promise.resolve(`value-of-${name}`))
    const parentProcess = makeFakeParentProcess()

    const resultPromise = injectAndRun(
      [
        { credentialName: 'DATABASE_URL', envVarName: 'DATABASE_URL' },
        { credentialName: 'API_TOKEN', envVarName: 'API_TOKEN' },
      ],
      'deploy',
      [],
      { getSecret, spawn, parentProcess }
    )
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    fakeChild.emitExit(0, null)
    await resultPromise

    expect(spawn).toHaveBeenCalledWith('deploy', [], {
      env: { DATABASE_URL: 'value-of-DATABASE_URL', API_TOKEN: 'value-of-API_TOKEN' },
      stdio: 'inherit',
    })
  })

  it('supports NAME=ENV_VAR renaming — the target env var can differ from the credential name', async () => {
    const fakeChild = makeFakeChild()
    const spawn = vi.fn().mockReturnValue(fakeChild)
    const getSecret = vi.fn().mockResolvedValue('renamed-value')
    const parentProcess = makeFakeParentProcess()

    const resultPromise = injectAndRun(
      [{ credentialName: 'my-db-password', envVarName: 'MY_DB_PASSWORD' }],
      'cmd',
      [],
      { getSecret, spawn, parentProcess }
    )
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    fakeChild.emitExit(0, null)
    await resultPromise

    expect(getSecret).toHaveBeenCalledWith('my-db-password')
    expect(spawn).toHaveBeenCalledWith('cmd', [], {
      env: { MY_DB_PASSWORD: 'renamed-value' },
      stdio: 'inherit',
    })
  })

  it('injects a secret renamed to `__proto__` as a real own property, not silently dropped via the Object.prototype accessor (code review fix)', async () => {
    const fakeChild = makeFakeChild()
    const spawn = vi.fn().mockReturnValue(fakeChild)
    const getSecret = vi.fn().mockResolvedValue('proto-secret-value')
    const parentProcess = makeFakeParentProcess()

    const resultPromise = injectAndRun(
      [{ credentialName: 'SOME_SECRET', envVarName: '__proto__' }],
      'cmd',
      [],
      { getSecret, spawn, parentProcess }
    )
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    fakeChild.emitExit(0, null)
    const result = await resultPromise

    expect(result).toEqual({ ok: true, exitCode: 0 })
    const spawnCall = spawn.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }]
    const env = spawnCall[2].env
    // A plain-object `{}` accumulator would let bracket-assignment `injected['__proto__'] = value`
    // hit Object.prototype's `__proto__` accessor and silently no-op instead of setting an own
    // property — the secret would vanish from the child's env with no error at all.
    expect(Object.prototype.hasOwnProperty.call(env, '__proto__')).toBe(true)
    expect(env.__proto__).toBe('proto-secret-value')
  })

  it('refuses a reserved/dangerous target env var name before any fetch', async () => {
    const spawn = vi.fn()
    const getSecret = vi.fn()
    const parentProcess = makeFakeParentProcess()

    const result = await injectAndRun(
      [{ credentialName: 'DB_PASSWORD', envVarName: 'LD_PRELOAD' }],
      'cmd',
      [],
      { getSecret, spawn, parentProcess }
    )

    expect(result.ok).toBe(false)
    expect(getSecret).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    if (!result.ok) {
      expect(result.exitCode).toBe(EXIT_CODES.usageError)
      expect(result.error).toContain('LD_PRELOAD')
    }
  })

  it('rejects a case-insensitive reserved name variant too', async () => {
    const spawn = vi.fn()
    const getSecret = vi.fn()
    const parentProcess = makeFakeParentProcess()

    const result = await injectAndRun(
      [{ credentialName: 'X', envVarName: 'ld_preload' }],
      'cmd',
      [],
      { getSecret, spawn, parentProcess }
    )

    expect(result.ok).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects a duplicate target env var name before any fetch', async () => {
    const spawn = vi.fn()
    const getSecret = vi.fn()
    const parentProcess = makeFakeParentProcess()

    const result = await injectAndRun(
      [
        { credentialName: 'A', envVarName: 'SAME' },
        { credentialName: 'B', envVarName: 'same' },
      ],
      'cmd',
      [],
      { getSecret, spawn, parentProcess }
    )

    expect(result.ok).toBe(false)
    expect(getSecret).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('fail-closed, all-or-nothing: a later secret failing aborts before spawn() is ever called, and never leaks an earlier value', async () => {
    const spawn = vi.fn()
    const getSecret = vi.fn().mockImplementation((name: string) => {
      if (name === 'A') return Promise.resolve('A-secret-value')
      return Promise.reject(new VaultAgentError('credential_not_found', 'not found'))
    })
    const parentProcess = makeFakeParentProcess()

    const result = await injectAndRun(
      [
        { credentialName: 'A', envVarName: 'A' },
        { credentialName: 'B', envVarName: 'B' },
      ],
      'cmd',
      [],
      { getSecret, spawn, parentProcess }
    )

    expect(spawn).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).not.toContain('A-secret-value')
      expect(result.exitCode).toBe(EXIT_CODES.credentialNotFound)
    }
  })

  it('maps an unexpected (non-VaultAgentError) fetch failure to the unexpected exit code', async () => {
    const spawn = vi.fn()
    const getSecret = vi.fn().mockRejectedValue(new Error('boom'))
    const parentProcess = makeFakeParentProcess()

    const result = await injectAndRun([{ credentialName: 'A', envVarName: 'A' }], 'cmd', [], {
      getSecret,
      spawn,
      parentProcess,
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.exitCode).toBe(EXIT_CODES.unexpected)
  })

  it('signals a per-secret provenance warning on stderr when a secret was served from the offline cache, without failing the command', async () => {
    const fakeChild = makeFakeChild()
    const spawn = vi.fn().mockReturnValue(fakeChild)
    const parentProcess = makeFakeParentProcess()
    const writeStderr = vi.fn()

    // Mirror cache-provenance.ts's own detection mechanism: a fetch() TypeError observed inside
    // getSecret() signals a cache-fallback happened.
    const getSecret = vi.fn().mockImplementation(async () => {
      try {
        await globalThis.fetch('http://example.invalid')
      } catch {
        // swallow — getSecret() itself would have fallen back to cache here
      }
      return 'stale-but-served-value'
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() => Promise.reject(new TypeError('network down'))) as typeof fetch

    try {
      const resultPromise = injectAndRun([{ credentialName: 'X', envVarName: 'X' }], 'cmd', [], {
        getSecret,
        spawn,
        parentProcess,
        writeStderr,
      })
      await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
      fakeChild.emitExit(0, null)
      const result = await resultPromise

      expect(result).toEqual({ ok: true, exitCode: 0 })
      expect(writeStderr).toHaveBeenCalledWith(
        expect.stringContaining("warning: 'X' served from offline cache")
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('injectAndRun — AC-2/AC-3: never puts secret values on argv', () => {
  it('never includes a fetched secret value in the args array passed to spawn', async () => {
    const fakeChild = makeFakeChild()
    const spawn = vi.fn().mockReturnValue(fakeChild)
    const getSecret = vi.fn().mockResolvedValue('totally-secret-value')
    const parentProcess = makeFakeParentProcess()

    const resultPromise = injectAndRun(
      [{ credentialName: 'X', envVarName: 'X' }],
      'echo',
      ['hello', 'world'],
      { getSecret, spawn, parentProcess }
    )
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    fakeChild.emitExit(0, null)
    await resultPromise

    const spawnCall = spawn.mock.calls[0] as [string, string[], unknown]
    expect(spawnCall[0]).toBe('echo')
    expect(spawnCall[1]).toEqual(['hello', 'world'])
    expect(spawnCall[1]).not.toContain('totally-secret-value')
  })
})

describe('injectAndRun — AC-4: exact exit code / signal propagation', () => {
  it('propagates a normal (non-zero) child exit code exactly', async () => {
    const fakeChild = makeFakeChild()
    const spawn = vi.fn().mockReturnValue(fakeChild)
    const getSecret = vi.fn().mockResolvedValue('v')
    const parentProcess = makeFakeParentProcess()

    const resultPromise = injectAndRun([{ credentialName: 'X', envVarName: 'X' }], 'cmd', [], {
      getSecret,
      spawn,
      parentProcess,
    })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    fakeChild.emitExit(7, null)
    const result = await resultPromise

    expect(result).toEqual({ ok: true, exitCode: 7 })
  })

  it('on POSIX, a signal-terminated child causes the parent to re-raise the same signal against itself', async () => {
    const fakeChild = makeFakeChild()
    const spawn = vi.fn().mockReturnValue(fakeChild)
    const getSecret = vi.fn().mockResolvedValue('v')
    const parentProcess = makeFakeParentProcess('linux')

    const resultPromise = injectAndRun([{ credentialName: 'X', envVarName: 'X' }], 'cmd', [], {
      getSecret,
      spawn,
      parentProcess,
    })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    fakeChild.emitExit(null, 'SIGTERM')
    const result = await resultPromise

    expect(parentProcess.killCalls).toEqual([[parentProcess.pid, 'SIGTERM']])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.terminatedBySignal).toBe('SIGTERM')
  })

  it('on Windows, falls back to the documented childSignalTerminated exit code instead of attempting a signal re-raise', async () => {
    const fakeChild = makeFakeChild()
    const spawn = vi.fn().mockReturnValue(fakeChild)
    const getSecret = vi.fn().mockResolvedValue('v')
    const parentProcess = makeFakeParentProcess('win32')

    const resultPromise = injectAndRun([{ credentialName: 'X', envVarName: 'X' }], 'cmd', [], {
      getSecret,
      spawn,
      parentProcess,
    })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    fakeChild.emitExit(null, 'SIGTERM')
    const result = await resultPromise

    expect(parentProcess.killCalls).toEqual([])
    expect(result).toEqual({
      ok: true,
      exitCode: EXIT_CODES.childSignalTerminated,
      terminatedBySignal: 'SIGTERM',
    })
  })

  const SPAWN_ERROR_TEST_SECRET_VALUE = 'the-fetched-secret-value'

  it("resolves with a failure result (never hangs) when spawn itself errors — e.g. a typo'd/missing target command (code review fix)", async () => {
    const fakeChild = makeFakeChild()
    const spawn = vi.fn().mockReturnValue(fakeChild)
    const getSecret = vi.fn().mockResolvedValue(SPAWN_ERROR_TEST_SECRET_VALUE)
    const parentProcess = makeFakeParentProcess()

    const resultPromise = injectAndRun(
      [{ credentialName: 'DATABASE_URL', envVarName: 'DATABASE_URL' }],
      'no-such-binary',
      [],
      { getSecret, spawn, parentProcess }
    )
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    fakeChild.emitError(Object.assign(new Error('spawn no-such-binary ENOENT'), { code: 'ENOENT' }))
    const result = await resultPromise

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.exitCode).toBe(EXIT_CODES.unexpected)
      expect(result.error).toContain('no-such-binary')
      expect(result.error).not.toContain(SPAWN_ERROR_TEST_SECRET_VALUE)
    }
  })

  it('does not double-resolve or re-forward SIGINT cleanup when both error and exit fire for the same child', async () => {
    const fakeChild = makeFakeChild()
    const spawn = vi.fn().mockReturnValue(fakeChild)
    const getSecret = vi.fn().mockResolvedValue(SPAWN_ERROR_TEST_SECRET_VALUE)
    const parentProcess = makeFakeParentProcess()

    const resultPromise = injectAndRun(
      [{ credentialName: 'DATABASE_URL', envVarName: 'DATABASE_URL' }],
      'cmd',
      [],
      { getSecret, spawn, parentProcess }
    )
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    fakeChild.emitError(new Error('boom'))
    fakeChild.emitExit(0, null)
    const result = await resultPromise

    // Whichever event fired first wins; the second must be a no-op, not a second resolution.
    expect(result.ok).toBe(false)
  })

  it('forwards a parent-received SIGINT to the running child', async () => {
    const fakeChild = makeFakeChild()
    const spawn = vi.fn().mockReturnValue(fakeChild)
    const getSecret = vi.fn().mockResolvedValue('v')
    const parentProcess = makeFakeParentProcess()

    const resultPromise = injectAndRun([{ credentialName: 'X', envVarName: 'X' }], 'cmd', [], {
      getSecret,
      spawn,
      parentProcess,
    })

    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())

    // Simulate the real process receiving SIGINT while the child is running.
    expect(parentProcess.sigintListeners).toHaveLength(1)
    parentProcess.sigintListeners[0]?.()
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGINT')

    fakeChild.emitExit(null, 'SIGINT')
    await resultPromise

    // The listener is removed once the child's own exit has fired — no dangling listener remains.
    expect(parentProcess.sigintListeners).toHaveLength(0)
  })
})
