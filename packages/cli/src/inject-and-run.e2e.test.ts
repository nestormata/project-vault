/**
 * Story 43.3 AC-4's own testing guidance — "at least one real end-to-end test ... that actually
 * spawns a trivial real child (e.g. `node -e "process.exit(3)"`) and asserts the real exit code
 * propagates, so the fake-injection unit tests don't silently diverge from Node's actual spawn()
 * behavior." This uses the real `node:child_process`'s `spawn` (not injected/faked) and a real
 * child process. `getSecret` is a stub in-memory function (this test is about real process
 * spawning/signal propagation, not about a real vault round trip — `get-command.e2e.test.ts`'s
 * real-Postgres/API-server precedent already covers the fetch side for Story 43.1's `runGet`).
 *
 * `parentProcess.kill` is deliberately a fake, never the real `process.kill` — re-raising a real
 * signal against the actual test-runner process would kill the test runner itself. The child
 * process spawned below IS real, and really does die from a real signal in the signal-propagation
 * test; only the "re-raise against the parent" half is observed via a fake.
 */
import { spawn as realSpawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  injectAndRun,
  type ChildProcessLike,
  type ParentProcessLike,
  type SpawnStdio,
} from './inject-and-run.js'

function makeRealSpawn() {
  return (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; stdio: SpawnStdio }
  ): ChildProcessLike => realSpawn(command, args, options) as unknown as ChildProcessLike
}

function makeFakeParentProcess(platform: NodeJS.Platform = 'linux'): ParentProcessLike & {
  killCalls: Array<[number, NodeJS.Signals]>
} {
  const killCalls: Array<[number, NodeJS.Signals]> = []
  return {
    pid: 99999,
    platform,
    on: () => {
      // No real SIGINT forwarding needed for these tests — the parent (this test process) never
      // receives a real SIGINT during the run.
    },
    removeListener: () => {},
    kill: (pid, signal) => {
      killCalls.push([pid, signal])
    },
    killCalls,
  }
}

describe('injectAndRun — real end-to-end child process (no mocked spawn)', () => {
  it('propagates a real child process exit code exactly', async () => {
    const getSecret = async (name: string): Promise<string> => `real-e2e-value-of-${name}`
    const parentProcess = makeFakeParentProcess()

    const result = await injectAndRun(
      [{ credentialName: 'E2E_SECRET', envVarName: 'E2E_SECRET' }],
      process.execPath,
      ['-e', 'process.exit(3)'],
      { getSecret, spawn: makeRealSpawn(), parentProcess, baseEnv: process.env }
    )

    expect(result).toEqual({ ok: true, exitCode: 3 })
  })

  it('actually injects the fetched secret into the real child process environment', async () => {
    // The child reads its own env var and exits with a code derived from it, proving the
    // injected value really landed in the real child's real environment (not just asserted
    // against a fake spawn call).
    const getSecret = async (): Promise<string> => '7'
    const parentProcess = makeFakeParentProcess()

    const result = await injectAndRun(
      [{ credentialName: 'E2E_EXIT_CODE', envVarName: 'E2E_EXIT_CODE' }],
      process.execPath,
      ['-e', 'process.exit(Number(process.env.E2E_EXIT_CODE))'],
      { getSecret, spawn: makeRealSpawn(), parentProcess, baseEnv: process.env }
    )

    expect(result).toEqual({ ok: true, exitCode: 7 })
  })

  it('propagates a real signal-terminated child by re-raising the same signal against the (faked) parent', async () => {
    const getSecret = async (): Promise<string> => 'v'
    const parentProcess = makeFakeParentProcess('linux')

    const result = await injectAndRun(
      [{ credentialName: 'X', envVarName: 'X' }],
      process.execPath,
      // The real child kills itself with a real SIGTERM — this really does produce a
      // signal-terminated exit from Node's real spawn() 'exit' event.
      ['-e', "process.kill(process.pid, 'SIGTERM')"],
      { getSecret, spawn: makeRealSpawn(), parentProcess, baseEnv: process.env }
    )

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.terminatedBySignal).toBe('SIGTERM')
    expect(parentProcess.killCalls).toEqual([[99999, 'SIGTERM']])
  })

  describe('Story 43.4 AC-2 — --secrets-fd over a real OS pipe', () => {
    it('delivers the value via FD 3 as JSON and NOT via the child environment', async () => {
      const getSecret = async (): Promise<string> => 'fd-delivered-value'
      const childScript = [
        "const fs = require('node:fs')",
        "const payload = JSON.parse(fs.readFileSync(3, 'utf8'))",
        "const viaFd = payload.E2E_FD_SECRET === 'fd-delivered-value'",
        "const notInEnv = !Object.hasOwn(process.env, 'E2E_FD_SECRET')",
        "const marker = process.env.PVAULT_SECRETS_FD === '3'",
        'process.exit(viaFd && notInEnv && marker ? 0 : 42)',
      ].join(';')

      const result = await injectAndRun(
        [{ credentialName: 'E2E_FD_SECRET', envVarName: 'E2E_FD_SECRET' }],
        process.execPath,
        ['-e', childScript],
        {
          getSecret,
          spawn: makeRealSpawn(),
          parentProcess: makeFakeParentProcess(),
          baseEnv: process.env,
          delivery: 'fd',
        }
      )

      expect(result).toEqual({ ok: true, exitCode: 0 })
    })

    it('a child that exits without reading a > 64 KiB payload returns its own exit code (EPIPE handled, no crash)', async () => {
      const stderr: string[] = []
      const result = await injectAndRun(
        [{ credentialName: 'BIG', envVarName: 'BIG' }],
        process.execPath,
        ['-e', 'process.exit(5)'],
        {
          getSecret: async () => 'x'.repeat(256 * 1024),
          spawn: makeRealSpawn(),
          parentProcess: makeFakeParentProcess(),
          baseEnv: process.env,
          delivery: 'fd',
          writeStderr: (chunk) => stderr.push(chunk),
        }
      )

      expect(result).toEqual({ ok: true, exitCode: 5 })
      expect(stderr).toEqual([])
    })

    it('a missing binary in fd mode reports the spawn failure without an unhandled pipe error or leaking the value', async () => {
      const stderr: string[] = []
      const result = await injectAndRun(
        [{ credentialName: 'X', envVarName: 'X' }],
        '/no/such/pvault-e2e-binary',
        [],
        {
          getSecret: async () => 'enoent-secret-value',
          spawn: makeRealSpawn(),
          parentProcess: makeFakeParentProcess(),
          baseEnv: process.env,
          delivery: 'fd',
          writeStderr: (chunk) => stderr.push(chunk),
        }
      )

      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).not.toContain('enoent-secret-value')
      expect(stderr).toEqual([])
    })

    it('closes the FD-3 write end on child exit even while a grandchild still holds FD 3 open (no parent hang)', async () => {
      let captured: { stdio?: ReadonlyArray<unknown> } | undefined
      const spawn = (
        command: string,
        args: string[],
        options: { env: NodeJS.ProcessEnv; stdio: SpawnStdio }
      ): ChildProcessLike => {
        const child = realSpawn(command, args, options)
        captured = child
        return child as unknown as ChildProcessLike
      }

      // The child backgrounds a grandchild that inherits FD 3 and outlives it — the pattern of a
      // start script that launches a daemon and exits.
      const result = await injectAndRun(
        [{ credentialName: 'X', envVarName: 'X' }],
        '/bin/sh',
        ['-c', '(sleep 5) & exit 0'],
        {
          getSecret: async () => 'grandchild-secret-value',
          spawn,
          parentProcess: makeFakeParentProcess(),
          baseEnv: process.env,
          delivery: 'fd',
        }
      )

      expect(result).toEqual({ ok: true, exitCode: 0 })
      const pipe = captured?.stdio?.[3] as { destroyed?: boolean } | undefined
      // An un-destroyed socket here keeps the real pvault process's event loop alive until the
      // grandchild exits, even though the child it was asked to run has already finished.
      expect(pipe?.destroyed).toBe(true)
    })
  })

  it('an env value Node refuses (NUL byte) fails cleanly and never echoes the value (spawn throws synchronously)', async () => {
    const result = await injectAndRun(
      [{ credentialName: 'NUL_SECRET', envVarName: 'NUL_SECRET' }],
      process.execPath,
      ['-e', 'process.exit(0)'],
      {
        getSecret: async () => 'nul-secret-value\u0000tail',
        spawn: makeRealSpawn(),
        parentProcess: makeFakeParentProcess(),
        baseEnv: process.env,
      }
    )

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).not.toContain('nul-secret-value')
  })
})
