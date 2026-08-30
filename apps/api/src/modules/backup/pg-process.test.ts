import { EventEmitter } from 'node:events'
import { describe, expect, it, vi, beforeEach } from 'vitest'

// Story 28.8: `runPgRestore` writes to `child.stdin` (a Writable stream, itself an independent
// EventEmitter from the `child` process object). Node delivers an EPIPE on that stream as an
// unhandled 'error' event if there's no listener attached to it specifically — a listener on
// `child` itself does NOT cover it. This file establishes this module's first direct test
// coverage (see Dev Notes) and pins the fix plus the two behaviors it must not regress.

type FakeChildProcess = EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: EventEmitter & { end: (data?: unknown) => void }
}

function createFakeChild(): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  const stdin = new EventEmitter() as EventEmitter & { end: (data?: unknown) => void }
  stdin.end = vi.fn()
  child.stdin = stdin
  return child
}

const CONNECTION_STRING = 'postgresql://user:pass@localhost:5432/db'

const spawnMock = vi.fn()

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}))

describe('Story 28.8: runPgRestore stdin error handling', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  it(
    'rejects with a PgProcessError instead of throwing unhandled when child.stdin emits an ' +
      "EPIPE-shaped 'error' (AC1/AC2/AC7) — an unfixed version of this code crashes the whole " +
      'Vitest worker process here, not just fails an assertion',
    async () => {
      const { runPgRestore, PgProcessError } = await import('./pg-process.js')
      const fakeChild = createFakeChild()
      spawnMock.mockReturnValue(fakeChild)

      const promise = runPgRestore(CONNECTION_STRING, Buffer.from('SELECT 1;'))

      // Simulate the EPIPE firing on the stdin stream itself, right as .end(sql) is invoked.
      const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -32 })
      fakeChild.stdin.emit('error', epipe)

      await expect(promise).rejects.toBeInstanceOf(PgProcessError)
      await expect(promise).rejects.toMatchObject({
        message: expect.stringContaining('EPIPE'),
      })
    }
  )

  it('resolves (void) when psql exits 0 after consuming stdin normally (AC4 happy path)', async () => {
    const { runPgRestore } = await import('./pg-process.js')
    const fakeChild = createFakeChild()
    spawnMock.mockReturnValue(fakeChild)

    const promise = runPgRestore(CONNECTION_STRING, Buffer.from('SELECT 1;'))

    fakeChild.emit('close', 0)

    await expect(promise).resolves.toBeUndefined()
  })

  it(
    'rejects with the existing PgProcessError message/stderr-tail shape when psql exits ' +
      'non-zero after fully consuming stdin (AC5, pre-existing behavior must not regress)',
    async () => {
      const { runPgRestore, PgProcessError } = await import('./pg-process.js')
      const fakeChild = createFakeChild()
      spawnMock.mockReturnValue(fakeChild)

      const promise = runPgRestore(CONNECTION_STRING, Buffer.from('SELECT 1;'))

      fakeChild.stderr.emit('data', Buffer.from('ERROR: relation "foo" does not exist\n'))
      fakeChild.emit('close', 1)

      await expect(promise).rejects.toBeInstanceOf(PgProcessError)
      await expect(promise).rejects.toMatchObject({
        message: 'psql restore exited with code 1',
        stderrTail: expect.stringContaining('relation "foo" does not exist'),
      })
    }
  )

  it(
    'settles exactly once when both a stdin error and the close event fire for the same ' +
      'failed restore attempt (AC6 — no double-settlement side effects)',
    async () => {
      const { runPgRestore, PgProcessError } = await import('./pg-process.js')
      const fakeChild = createFakeChild()
      spawnMock.mockReturnValue(fakeChild)

      let settleCount = 0
      const promise = runPgRestore(CONNECTION_STRING, Buffer.from('SELECT 1;')).catch((err) => {
        settleCount += 1
        return err
      })

      const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -32 })
      fakeChild.stdin.emit('error', epipe)
      // Race: the child process also exits non-zero for the same underlying failure.
      fakeChild.emit('close', 1)

      const result = await promise
      expect(result).toBeInstanceOf(PgProcessError)
      expect(settleCount).toBe(1)
    }
  )
})
