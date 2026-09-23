/**
 * Story 43.3 AC-6 — the "non-CLI caller" test. This file imports ONLY `injectAndRun` (never
 * `cli.ts`, `buildProgram`, or anything commander-related) and invokes it directly with a
 * hand-built `entries`/`command`/`deps` argument list, exactly as a hypothetical Epic 50 broker
 * (FR177's `inject_env`) would once its own gated design pass completes. This is the concrete,
 * executable proof that the injection primitive is structurally consumable without going through
 * `pvault`'s argv/commander surface — see this story's Origin section and Open Question #1 for why
 * this is a structural proof, not a real cross-package integration (Epic 50 has zero
 * implementation stories today).
 */
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  hardenProcessDiagnostics,
  injectAndRun,
  type ChildProcessLike,
  type ParentProcessLike,
} from './inject-and-run.js'

const DEPLOY_TOKEN = 'DEPLOY_TOKEN'
const BROKER_VALUE = 'broker-fetched-value'
const DEPLOY_TOOL = 'deploy-tool'

describe('injectAndRun as a non-CLI caller (Epic 50 seam proof)', () => {
  it('a hand-built caller with no CLI/commander involvement can fetch a secret and spawn a command with it injected', async () => {
    const emitter = new EventEmitter()
    const fakeChild: ChildProcessLike = {
      on: (event, listener) => {
        emitter.on(event, listener)
      },
      kill: vi.fn().mockReturnValue(true),
    }
    const spawn = vi.fn().mockReturnValue(fakeChild)
    const parentProcess: ParentProcessLike = {
      pid: 4242,
      platform: 'linux',
      on: vi.fn(),
      removeListener: vi.fn(),
      kill: vi.fn(),
    }

    // A hypothetical broker resolves its own secret store however it likes — here, a plain
    // in-memory lookup with no HTTP, no @project-vault/agent, no CLI parsing whatsoever.
    const secretStore: Record<string, string> = { [DEPLOY_TOKEN]: BROKER_VALUE }
    const getSecret = async (name: string): Promise<string> => {
      const value = secretStore[name]
      if (value === undefined) throw new Error(`unknown secret: ${name}`)
      return value
    }

    const resultPromise = injectAndRun(
      [{ credentialName: DEPLOY_TOKEN, envVarName: DEPLOY_TOKEN }],
      DEPLOY_TOOL,
      ['--flag'],
      { getSecret, spawn, parentProcess }
    )

    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    emitter.emit('exit', 0, null)
    const result = await resultPromise

    expect(result).toEqual({ ok: true, exitCode: 0 })
    expect(spawn).toHaveBeenCalledWith(DEPLOY_TOOL, ['--flag'], {
      env: { [DEPLOY_TOKEN]: BROKER_VALUE },
      stdio: 'inherit',
    })
  })

  it('Story 43.4 AC-5 — the same seam gives a non-CLI caller FD delivery, the audit context, the caller-credential strip, and diagnostics hardening for free', async () => {
    const emitter = new EventEmitter()
    const written: string[] = []
    const fdPipe = {
      on: vi.fn(),
      end: (chunk: string) => {
        written.push(chunk)
      },
    }
    const fakeChild: ChildProcessLike = {
      on: (event, listener) => {
        emitter.on(event, listener)
      },
      kill: vi.fn().mockReturnValue(true),
      stdio: [null, null, null, fdPipe],
    }
    const spawn = vi.fn().mockReturnValue(fakeChild)
    const parentProcess: ParentProcessLike = {
      pid: 4242,
      platform: 'linux',
      on: vi.fn(),
      removeListener: vi.fn(),
      kill: vi.fn(),
    }
    const getSecret = vi.fn(async () => BROKER_VALUE)

    const resultPromise = injectAndRun(
      [{ credentialName: DEPLOY_TOKEN, envVarName: DEPLOY_TOKEN }],
      `/opt/tools/${DEPLOY_TOOL}`,
      ['--flag'],
      {
        getSecret,
        spawn,
        parentProcess,
        baseEnv: { VAULT_API_KEY: 'broker-own-key', HOME: '/home/broker' },
        delivery: 'fd',
      }
    )
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled())
    emitter.emit('exit', 0, null)

    expect(await resultPromise).toEqual({ ok: true, exitCode: 0 })
    // The audit context is computed by the seam, not by any CLI adapter.
    expect(getSecret).toHaveBeenCalledWith(DEPLOY_TOKEN, {
      invocation: 'run',
      targetCommand: DEPLOY_TOOL,
    })
    expect(spawn).toHaveBeenCalledWith(`/opt/tools/${DEPLOY_TOOL}`, ['--flag'], {
      env: { HOME: '/home/broker', PVAULT_SECRETS_FD: '3' },
      stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
    })
    expect(JSON.parse(written[0] ?? '')).toEqual({ [DEPLOY_TOKEN]: BROKER_VALUE })

    const brokerProcess = {
      report: { reportOnFatalError: true, reportOnSignal: true, reportOnUncaughtException: true },
    }
    hardenProcessDiagnostics(brokerProcess)
    expect(Object.values(brokerProcess.report)).toEqual([false, false, false])
  })
})
