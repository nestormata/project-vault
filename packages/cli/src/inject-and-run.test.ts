import { EventEmitter } from 'node:events'
import { VaultAgentError } from '@project-vault/agent'
import { describe, expect, it, vi } from 'vitest'
import { EXIT_CODES } from './exit-codes.js'
import {
  CALLER_CREDENTIAL_ENV_VARS,
  commandBasename,
  hardenProcessDiagnostics,
  injectAndRun,
  SECRETS_FD_ENV_VAR,
  type ChildProcessLike,
  type ParentProcessLike,
  type SecretsPipeLike,
} from './inject-and-run.js'

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

    expect(getSecret).toHaveBeenCalledWith('DATABASE_URL', {
      invocation: 'run',
      targetCommand: 'psql',
    })
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

    expect(getSecret).toHaveBeenCalledWith('my-db-password', {
      invocation: 'run',
      targetCommand: 'cmd',
    })
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
        "warning: 'X' served from offline cache (vault unreachable), value may be stale and this fetch is not recorded in the vault audit log\n"
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

  it('a spawn() that throws synchronously resolves with a failure built from error.code only — never the thrown message, which can echo an env value (code review fix)', async () => {
    // Real Node's spawn() throws ERR_INVALID_ARG_VALUE for an env value containing a NUL byte,
    // and its message quotes the offending value verbatim.
    const spawn = vi.fn().mockImplementation(() => {
      throw Object.assign(
        new TypeError(
          `The property 'options.env['DATABASE_URL']' must be a string without null bytes. Received '${SPAWN_ERROR_TEST_SECRET_VALUE}'`
        ),
        { code: 'ERR_INVALID_ARG_VALUE' }
      )
    })
    const parentProcess = makeFakeParentProcess()

    const result = await injectAndRun(
      [{ credentialName: 'DATABASE_URL', envVarName: 'DATABASE_URL' }],
      'psql',
      [],
      {
        getSecret: vi.fn().mockResolvedValue(SPAWN_ERROR_TEST_SECRET_VALUE),
        spawn,
        parentProcess,
      }
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.exitCode).toBe(EXIT_CODES.unexpected)
      expect(result.error).toContain('psql')
      expect(result.error).toContain('ERR_INVALID_ARG_VALUE')
      expect(result.error).not.toContain(SPAWN_ERROR_TEST_SECRET_VALUE)
    }
    // Nothing was spawned, so no SIGINT forwarding listener may be left behind.
    expect(parentProcess.sigintListeners).toHaveLength(0)
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

const FD_TEST_SECRET_VALUE = 'x-secret-value'

type FakePipe = SecretsPipeLike & {
  written: string[]
  ended: boolean
  destroyed: boolean
  emitError: (error: NodeJS.ErrnoException) => void
}

/** A fake FD-3 write end: records what was written and lets a test emit a stream 'error'. */
function makeFakePipe(): FakePipe {
  const errorListeners: Array<(error: NodeJS.ErrnoException) => void> = []
  const pipe: FakePipe = {
    written: [],
    ended: false,
    destroyed: false,
    destroy: () => {
      pipe.destroyed = true
      return pipe
    },
    on: (_event, listener) => {
      errorListeners.push(listener)
      return pipe
    },
    end: (chunk) => {
      pipe.written.push(chunk)
      pipe.ended = true
      return pipe
    },
    emitError: (error) => {
      for (const listener of errorListeners) listener(error)
    },
  }
  return pipe
}

function makeFakeChildWithPipe(pipe: SecretsPipeLike | null) {
  return Object.assign(makeFakeChild(), { stdio: [null, null, null, pipe] })
}

type SpawnOptionsSeen = { env: NodeJS.ProcessEnv; stdio: unknown }
function spawnOptions(spawn: ReturnType<typeof vi.fn>): SpawnOptionsSeen {
  return (spawn.mock.calls[0] as [string, string[], SpawnOptionsSeen])[2]
}

describe('injectAndRun — Story 43.4 AC-1: the child never inherits pvault’s own credential', () => {
  it('names VAULT_API_KEY as the stripped caller credential', () => {
    expect(CALLER_CREDENTIAL_ENV_VARS).toEqual(['VAULT_API_KEY'])
  })

  it('strips VAULT_API_KEY from the inherited env (absent, not undefined), keeping everything else', async () => {
    const fakeChild = makeFakeChild()
    const spawn = vi.fn().mockReturnValue(fakeChild)
    const resultPromise = injectAndRun([{ credentialName: 'A', envVarName: 'A' }], 'cmd', [], {
      getSecret: vi.fn().mockResolvedValue('a-value'),
      spawn,
      parentProcess: makeFakeParentProcess(),
      baseEnv: { VAULT_API_KEY: 'pk_machine_key', PATH: '/bin', VAULT_URL: 'https://v' },
    })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    fakeChild.emitExit(0, null)
    await resultPromise

    const { env } = spawnOptions(spawn)
    expect(Object.hasOwn(env, 'VAULT_API_KEY')).toBe(false)
    expect(env).toEqual({ PATH: '/bin', VAULT_URL: 'https://v', A: 'a-value' })
  })

  it('an explicitly requested --secret VAULT_API_KEY is still injected (the strip applies to the inherited env only)', async () => {
    const fakeChild = makeFakeChild()
    const spawn = vi.fn().mockReturnValue(fakeChild)
    const resultPromise = injectAndRun(
      [{ credentialName: 'VAULT_API_KEY', envVarName: 'VAULT_API_KEY' }],
      'cmd',
      [],
      {
        getSecret: vi.fn().mockResolvedValue('vault-stored-key'),
        spawn,
        parentProcess: makeFakeParentProcess(),
        baseEnv: { VAULT_API_KEY: 'pk_machine_key' },
      }
    )
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    fakeChild.emitExit(0, null)
    await resultPromise

    expect(spawnOptions(spawn).env['VAULT_API_KEY']).toBe('vault-stored-key')
  })
})

describe('hardenProcessDiagnostics (Story 43.4 AC-1)', () => {
  it('turns off every Node diagnostic-report trigger that would dump pvault’s env to disk', () => {
    const proc = {
      report: { reportOnFatalError: true, reportOnSignal: true, reportOnUncaughtException: true },
    }
    hardenProcessDiagnostics(proc)
    expect(proc.report).toEqual({
      reportOnFatalError: false,
      reportOnSignal: false,
      reportOnUncaughtException: false,
    })
  })

  it('is a no-op on a runtime without process.report', () => {
    expect(() => hardenProcessDiagnostics({})).not.toThrow()
  })
})

describe('injectAndRun — Story 43.4 AC-2: --secrets-fd delivery over an anonymous pipe on FD 3', () => {
  async function runFd(
    values: Record<string, string>,
    opts: { baseEnv?: NodeJS.ProcessEnv; pipe?: FakePipe | null } = {}
  ) {
    const pipe = opts.pipe === undefined ? makeFakePipe() : opts.pipe
    const fakeChild = makeFakeChildWithPipe(pipe)
    const spawn = vi.fn().mockReturnValue(fakeChild)
    const writeStderr = vi.fn()
    const entries = Object.keys(values).map((name) => ({ credentialName: name, envVarName: name }))
    const resultPromise = injectAndRun(entries, 'node', ['app.js'], {
      getSecret: vi
        .fn()
        .mockImplementation((name: string) =>
          Promise.resolve(new Map(Object.entries(values)).get(name))
        ),
      spawn,
      parentProcess: makeFakeParentProcess(),
      baseEnv: opts.baseEnv ?? { PATH: '/bin' },
      writeStderr,
      delivery: 'fd',
    })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    return { pipe, fakeChild, spawn, writeStderr, resultPromise }
  }

  it('spawns with a fourth pipe stdio slot, writes one JSON object then EOF, and sets only the marker in env', async () => {
    const { pipe, fakeChild, spawn, resultPromise } = await runFd(
      { DB_PASSWORD: 's3cr3t', TLS_KEY: '-----BEGIN-----\nabc\n-----END-----' },
      { baseEnv: { PATH: '/bin', VAULT_API_KEY: 'pk_x', PVAULT_SECRETS_FD: '9' } }
    )
    fakeChild.emitExit(0, null)
    expect(await resultPromise).toEqual({ ok: true, exitCode: 0 })

    const options = spawnOptions(spawn)
    expect(options.stdio).toEqual(['inherit', 'inherit', 'inherit', 'pipe'])
    expect(options.env).toEqual({ PATH: '/bin', [SECRETS_FD_ENV_VAR]: '3' })
    expect(SECRETS_FD_ENV_VAR).toBe('PVAULT_SECRETS_FD')
    expect(pipe?.ended).toBe(true)
    expect(pipe?.written).toHaveLength(1)
    expect(pipe?.written[0]?.endsWith('\n')).toBe(false)
    expect(JSON.parse(pipe?.written[0] ?? '')).toEqual({
      DB_PASSWORD: 's3cr3t',
      TLS_KEY: '-----BEGIN-----\nabc\n-----END-----',
    })
  })

  it('round-trips awkward values exactly (newline, quote, backslash, =, NUL, non-BMP emoji)', async () => {
    const values = {
      NL: 'a\nb',
      QUOTE: 'say "hi"',
      BACKSLASH: 'C:\\path\\x',
      EQUALS: 'k=v=w',
      NUL: 'before\u0000after',
      EMOJI: 'key-\u{1F511}',
    }
    const { pipe, fakeChild, resultPromise } = await runFd(values)
    fakeChild.emitExit(0, null)
    await resultPromise
    expect(JSON.parse(pipe?.written[0] ?? '')).toEqual(values)
  })

  it('a `__proto__` target key serializes as an ordinary key and parses back as an own property', async () => {
    const pipe = makeFakePipe()
    const fakeChild = makeFakeChildWithPipe(pipe)
    const spawn = vi.fn().mockReturnValue(fakeChild)
    const resultPromise = injectAndRun(
      [{ credentialName: 'S', envVarName: '__proto__' }],
      'cmd',
      [],
      {
        getSecret: vi.fn().mockResolvedValue('proto-value'),
        spawn,
        parentProcess: makeFakeParentProcess(),
        delivery: 'fd',
      }
    )
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    fakeChild.emitExit(0, null)
    await resultPromise

    const parsed = JSON.parse(pipe.written[0] ?? '') as Record<string, unknown>
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true)
    expect(parsed['__proto__']).toBe('proto-value')
  })

  it('EPIPE after the child exited without reading is swallowed: the child’s own exit code is returned, nothing printed', async () => {
    const { pipe, fakeChild, writeStderr, resultPromise } = await runFd({ X: FD_TEST_SECRET_VALUE })
    pipe?.emitError(
      Object.assign(new Error(`write EPIPE ${FD_TEST_SECRET_VALUE}`), { code: 'EPIPE' })
    )
    fakeChild.emitExit(4, null)

    expect(await resultPromise).toEqual({ ok: true, exitCode: 4 })
    expect(writeStderr).not.toHaveBeenCalled()
  })

  it.each(['ECONNRESET', 'ERR_STREAM_DESTROYED'])(
    '%s (how a reader that went away surfaces on Node’s socketpair-backed stdio pipe) is swallowed like EPIPE',
    async (code) => {
      const { pipe, fakeChild, writeStderr, resultPromise } = await runFd({
        X: FD_TEST_SECRET_VALUE,
      })
      pipe?.emitError(Object.assign(new Error(`write ${code}`), { code }))
      fakeChild.emitExit(0, null)

      expect(await resultPromise).toEqual({ ok: true, exitCode: 0 })
      expect(writeStderr).not.toHaveBeenCalled()
    }
  )

  it('a non-EPIPE pipe error prints a line built only from error.code (never the payload) and keeps the exit-code contract', async () => {
    const { pipe, fakeChild, writeStderr, resultPromise } = await runFd({ X: FD_TEST_SECRET_VALUE })
    pipe?.emitError(Object.assign(new Error(`boom ${FD_TEST_SECRET_VALUE}`), { code: 'EIO' }))
    fakeChild.emitExit(0, null)

    expect(await resultPromise).toEqual({ ok: true, exitCode: 0 })
    const printed = writeStderr.mock.calls.map((c) => String(c[0])).join('')
    expect(printed).toContain('EIO')
    expect(printed).not.toContain(FD_TEST_SECRET_VALUE)
  })

  it('a > 64 KiB payload with a child that never reads still settles on exit (never awaits the write)', async () => {
    const { fakeChild, resultPromise } = await runFd({ BIG: 'x'.repeat(70 * 1024) })
    fakeChild.emitExit(0, null)
    expect(await resultPromise).toEqual({ ok: true, exitCode: 0 })
  })

  it('releases the FD-3 write end once the child exits, so a grandchild still holding FD 3 cannot keep pvault alive (code review fix)', async () => {
    const { pipe, fakeChild, resultPromise } = await runFd({ X: FD_TEST_SECRET_VALUE })
    expect(pipe?.destroyed).toBe(false)
    fakeChild.emitExit(0, null)
    await resultPromise
    expect(pipe?.destroyed).toBe(true)
  })

  it('releases the FD-3 write end when the spawn itself errors (code review fix)', async () => {
    const { pipe, fakeChild, resultPromise } = await runFd({ X: FD_TEST_SECRET_VALUE })
    fakeChild.emitError(Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }))
    await resultPromise
    expect(pipe?.destroyed).toBe(true)
  })

  it('no stdio[3] (spawn failed) — no write attempted, no throw, the spawn error is reported', async () => {
    const { fakeChild, resultPromise } = await runFd({ X: FD_TEST_SECRET_VALUE }, { pipe: null })
    fakeChild.emitError(Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' }))
    const result = await resultPromise
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).not.toContain(FD_TEST_SECRET_VALUE)
  })

  it('a child with no stdio array at all (43.3-style fake) is tolerated in fd mode', async () => {
    const fakeChild = makeFakeChild()
    const spawn = vi.fn().mockReturnValue(fakeChild)
    const resultPromise = injectAndRun([{ credentialName: 'X', envVarName: 'X' }], 'cmd', [], {
      getSecret: vi.fn().mockResolvedValue('v'),
      spawn,
      parentProcess: makeFakeParentProcess(),
      delivery: 'fd',
    })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    fakeChild.emitExit(0, null)
    expect(await resultPromise).toEqual({ ok: true, exitCode: 0 })
  })

  it('fail-closed: nothing is spawned or written when a later secret fails to fetch', async () => {
    const spawn = vi.fn()
    const result = await injectAndRun(
      [
        { credentialName: 'A', envVarName: 'A' },
        { credentialName: 'B', envVarName: 'B' },
      ],
      'cmd',
      [],
      {
        getSecret: vi
          .fn()
          .mockImplementation((name: string) =>
            name === 'A'
              ? Promise.resolve('a-value')
              : Promise.reject(new VaultAgentError('credential_not_found', 'nope'))
          ),
        spawn,
        parentProcess: makeFakeParentProcess(),
        delivery: 'fd',
      }
    )
    expect(spawn).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
  })

  it('reserved-name refusal still runs in fd mode even though no env var is set', async () => {
    const spawn = vi.fn()
    const result = await injectAndRun(
      [{ credentialName: 'X', envVarName: 'LD_PRELOAD' }],
      'cmd',
      [],
      { getSecret: vi.fn(), spawn, parentProcess: makeFakeParentProcess(), delivery: 'fd' }
    )
    expect(result.ok).toBe(false)
    expect(spawn).not.toHaveBeenCalled()
  })
})

describe('injectAndRun — Story 43.4 AC-3: invocation context supplied by the seam on every fetch', () => {
  it.each([
    ['psql', 'psql'],
    ['/usr/bin/psql', 'psql'],
    ['./deploy.sh', 'deploy.sh'],
    ['C:\\tools\\psql.exe', 'psql.exe'],
    ['env', 'env'],
    ['/opt/データ.sh', 'データ.sh'],
    ['bin/', ''],
  ])('commandBasename(%j) === %j', (command, expected) => {
    expect(commandBasename(command)).toBe(expected)
  })

  it('passes the same { invocation: run, targetCommand } context on every secret’s fetch', async () => {
    const fakeChild = makeFakeChild()
    const spawn = vi.fn().mockReturnValue(fakeChild)
    const getSecret = vi.fn().mockResolvedValue('v')
    const resultPromise = injectAndRun(
      [
        { credentialName: 'A', envVarName: 'A' },
        { credentialName: 'B', envVarName: 'B' },
      ],
      '/usr/local/bin/deploy',
      ['--prod', '--password=hunter2'],
      { getSecret, spawn, parentProcess: makeFakeParentProcess() }
    )
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    fakeChild.emitExit(0, null)
    await resultPromise

    expect(getSecret.mock.calls).toEqual([
      ['A', { invocation: 'run', targetCommand: 'deploy' }],
      ['B', { invocation: 'run', targetCommand: 'deploy' }],
    ])
    // Never full argv — the context carries only the basename.
    expect(JSON.stringify(getSecret.mock.calls)).not.toContain('hunter2')
  })

  it('omits targetCommand when the command has no basename', async () => {
    const fakeChild = makeFakeChild()
    const spawn = vi.fn().mockReturnValue(fakeChild)
    const getSecret = vi.fn().mockResolvedValue('v')
    const resultPromise = injectAndRun([{ credentialName: 'A', envVarName: 'A' }], 'bin/', [], {
      getSecret,
      spawn,
      parentProcess: makeFakeParentProcess(),
    })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    fakeChild.emitExit(0, null)
    await resultPromise
    expect(getSecret).toHaveBeenCalledWith('A', { invocation: 'run' })
  })

  it('a server audit-write failure on secret B (503 → vault_request_failed) means exactly one context-carrying fetch (A) and no spawn', async () => {
    const spawn = vi.fn()
    const getSecret = vi
      .fn()
      .mockImplementation((name: string) =>
        name === 'A'
          ? Promise.resolve('a-value')
          : Promise.reject(new VaultAgentError('vault_request_failed', 'HTTP 503'))
      )
    const result = await injectAndRun(
      [
        { credentialName: 'A', envVarName: 'A' },
        { credentialName: 'B', envVarName: 'B' },
        { credentialName: 'C', envVarName: 'C' },
      ],
      'psql',
      [],
      { getSecret, spawn, parentProcess: makeFakeParentProcess() }
    )
    expect(spawn).not.toHaveBeenCalled()
    expect(getSecret).toHaveBeenCalledTimes(2)
    expect(getSecret.mock.calls[0]).toEqual(['A', { invocation: 'run', targetCommand: 'psql' }])
    expect(result).toMatchObject({ ok: false, exitCode: EXIT_CODES.vaultRequestFailed })
    if (!result.ok) expect(result.error).not.toContain('a-value')
  })

  it('--secrets-fd invocations send the identical audit context as the default env path', async () => {
    const calls: unknown[][] = []
    for (const delivery of ['env', 'fd'] as const) {
      const fakeChild = makeFakeChildWithPipe(makeFakePipe())
      const spawn = vi.fn().mockReturnValue(fakeChild)
      const getSecret = vi.fn().mockResolvedValue('v')
      const resultPromise = injectAndRun([{ credentialName: 'A', envVarName: 'A' }], 'psql', [], {
        getSecret,
        spawn,
        parentProcess: makeFakeParentProcess(),
        delivery,
      })
      await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
      fakeChild.emitExit(0, null)
      await resultPromise
      calls.push(getSecret.mock.calls[0] ?? [])
    }
    expect(calls[0]).toEqual(calls[1])
  })
})
