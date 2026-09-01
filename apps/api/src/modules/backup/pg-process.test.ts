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
const EXIT_CODE_1_MESSAGE = 'psql restore exited with code 1'

function createEpipeError(): Error {
  return Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -32 })
}

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
      const epipe = createEpipeError()
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
        message: EXIT_CODE_1_MESSAGE,
        stderrTail: expect.stringContaining('relation "foo" does not exist'),
      })
    }
  )

  it(
    "rejects with a PgProcessError when the child process itself emits 'error' (e.g. spawn " +
      'failure) — the pre-existing child-level handler, now sharing the settled guard',
    async () => {
      const { runPgRestore, PgProcessError } = await import('./pg-process.js')
      const fakeChild = createFakeChild()
      spawnMock.mockReturnValue(fakeChild)

      const promise = runPgRestore(CONNECTION_STRING, Buffer.from('SELECT 1;'))

      fakeChild.emit('error', new Error('spawn psql ENOENT'))

      await expect(promise).rejects.toBeInstanceOf(PgProcessError)
      await expect(promise).rejects.toMatchObject({
        message: expect.stringContaining('spawn psql ENOENT'),
      })
    }
  )

  it(
    "does not re-settle when the child process emits 'error' after 'close' already settled " +
      "the promise (AC6, other direction) — child.on('error')'s own settled guard",
    async () => {
      const { runPgRestore, PgProcessError } = await import('./pg-process.js')
      const fakeChild = createFakeChild()
      spawnMock.mockReturnValue(fakeChild)

      let settleCount = 0
      const promise = runPgRestore(CONNECTION_STRING, Buffer.from('SELECT 1;')).catch((err) => {
        settleCount += 1
        return err
      })

      fakeChild.emit('close', 1)
      fakeChild.emit('error', new Error('late spawn error after close'))

      const result = await promise
      expect(result).toBeInstanceOf(PgProcessError)
      expect(result.message).toBe(EXIT_CODE_1_MESSAGE)
      expect(settleCount).toBe(1)
    }
  )

  it(
    "does not re-settle when child.stdin emits 'error' after 'close' already settled the " +
      "promise (AC6, other direction) — child.stdin.on('error')'s own settled guard",
    async () => {
      const { runPgRestore, PgProcessError } = await import('./pg-process.js')
      const fakeChild = createFakeChild()
      spawnMock.mockReturnValue(fakeChild)

      let settleCount = 0
      const promise = runPgRestore(CONNECTION_STRING, Buffer.from('SELECT 1;')).catch((err) => {
        settleCount += 1
        return err
      })

      fakeChild.emit('close', 1)
      const epipe = createEpipeError()
      fakeChild.stdin.emit('error', epipe)

      const result = await promise
      expect(result).toBeInstanceOf(PgProcessError)
      expect(result.message).toBe(EXIT_CODE_1_MESSAGE)
      expect(settleCount).toBe(1)
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

      const epipe = createEpipeError()
      fakeChild.stdin.emit('error', epipe)
      // Race: the child process also exits non-zero for the same underlying failure.
      fakeChild.emit('close', 1)

      const result = await promise
      expect(result).toBeInstanceOf(PgProcessError)
      expect(settleCount).toBe(1)
    }
  )
})

// Story 28.11: closes the identical structural hazard on the READ side. `child.stdout`/
// `child.stderr` are themselves independent Readable-stream EventEmitters from the `child`
// process object, exactly the same way `child.stdin` is an independent Writable-stream
// EventEmitter (fixed for stdin by Story 28.8 above). Neither `runPgDump` nor `runPgRestore`
// previously attached an 'error' listener to stdout/stderr — only '.on(\'data\', ...)', which does
// not cover a stream-level 'error' event. An unfixed version of this code crashes the whole
// Vitest worker process on these tests, not just fails an assertion.

function createFakeDumpChild(): FakeChildProcess {
  return createFakeChild()
}

describe('Story 28.11: runPgDump stdout/stderr error handling', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  it(
    'rejects with a PgProcessError instead of throwing unhandled when child.stdout emits an ' +
      "EPIPE-shaped 'error' (AC1/AC2/AC3/AC4)",
    async () => {
      const { runPgDump, PgProcessError } = await import('./pg-process.js')
      const fakeChild = createFakeDumpChild()
      spawnMock.mockReturnValue(fakeChild)

      const promise = runPgDump(CONNECTION_STRING)

      const epipe = createEpipeError()
      fakeChild.stdout.emit('error', epipe)

      await expect(promise).rejects.toBeInstanceOf(PgProcessError)
      await expect(promise).rejects.toMatchObject({
        message: expect.stringContaining('pg_dump: stdout read failed'),
      })
      await expect(promise).rejects.toMatchObject({
        message: expect.stringContaining('EPIPE'),
      })
    }
  )

  it(
    'rejects with a PgProcessError instead of throwing unhandled when child.stderr emits an ' +
      "EPIPE-shaped 'error' (AC1/AC2/AC3/AC4)",
    async () => {
      const { runPgDump, PgProcessError } = await import('./pg-process.js')
      const fakeChild = createFakeDumpChild()
      spawnMock.mockReturnValue(fakeChild)

      const promise = runPgDump(CONNECTION_STRING)

      const epipe = createEpipeError()
      fakeChild.stderr.emit('error', epipe)

      await expect(promise).rejects.toBeInstanceOf(PgProcessError)
      await expect(promise).rejects.toMatchObject({
        message: expect.stringContaining('pg_dump: stderr read failed'),
      })
      await expect(promise).rejects.toMatchObject({
        message: expect.stringContaining('EPIPE'),
      })
    }
  )

  it('resolves with the buffered stdout when pg_dump exits 0 (AC5 happy path, no regression)', async () => {
    const { runPgDump } = await import('./pg-process.js')
    const fakeChild = createFakeDumpChild()
    spawnMock.mockReturnValue(fakeChild)

    const promise = runPgDump(CONNECTION_STRING)

    fakeChild.stdout.emit('data', Buffer.from('-- dump output\n'))
    fakeChild.emit('close', 0)

    const result = await promise
    expect(result).toBeInstanceOf(Buffer)
    expect(result.toString('utf8')).toBe('-- dump output\n')
  })

  it(
    'rejects with the existing PgProcessError message/stderr-tail shape when pg_dump exits ' +
      'non-zero (AC6, pre-existing behavior must not regress)',
    async () => {
      const { runPgDump, PgProcessError } = await import('./pg-process.js')
      const fakeChild = createFakeDumpChild()
      spawnMock.mockReturnValue(fakeChild)

      const promise = runPgDump(CONNECTION_STRING)

      fakeChild.stderr.emit('data', Buffer.from('pg_dump: error: connection failed\n'))
      fakeChild.emit('close', 1)

      await expect(promise).rejects.toBeInstanceOf(PgProcessError)
      await expect(promise).rejects.toMatchObject({
        message: 'pg_dump exited with code 1',
        stderrTail: expect.stringContaining('connection failed'),
      })
    }
  )

  it(
    "does not re-settle when child.stdout emits 'error' after 'close' already settled the " +
      'promise (AC4 — exercises the new settled guard introduced for runPgDump)',
    async () => {
      const { runPgDump } = await import('./pg-process.js')
      const fakeChild = createFakeDumpChild()
      spawnMock.mockReturnValue(fakeChild)

      let settleCount = 0
      const promise = runPgDump(CONNECTION_STRING).catch((err) => {
        settleCount += 1
        return err
      })

      fakeChild.emit('close', 0)
      fakeChild.stdout.emit('error', createEpipeError())

      const result = await promise
      expect(result).toBeInstanceOf(Buffer)
      expect(settleCount).toBe(0)
    }
  )
})

describe('Story 28.11: runPgRestore stdout/stderr error handling', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  it(
    'rejects with a PgProcessError instead of throwing unhandled when child.stdout emits an ' +
      "EPIPE-shaped 'error' (AC1/AC2/AC3/AC4/AC7 — runPgRestore has no other stdout listener)",
    async () => {
      const { runPgRestore, PgProcessError } = await import('./pg-process.js')
      const fakeChild = createFakeChild()
      spawnMock.mockReturnValue(fakeChild)

      const promise = runPgRestore(CONNECTION_STRING, Buffer.from('SELECT 1;'))

      const epipe = createEpipeError()
      fakeChild.stdout.emit('error', epipe)

      await expect(promise).rejects.toBeInstanceOf(PgProcessError)
      await expect(promise).rejects.toMatchObject({
        message: expect.stringContaining('psql restore: stdout read failed'),
      })
      await expect(promise).rejects.toMatchObject({
        message: expect.stringContaining('EPIPE'),
      })
    }
  )

  it(
    'rejects with a PgProcessError instead of throwing unhandled when child.stderr emits an ' +
      "EPIPE-shaped 'error' (AC1/AC2/AC3/AC4/AC7)",
    async () => {
      const { runPgRestore, PgProcessError } = await import('./pg-process.js')
      const fakeChild = createFakeChild()
      spawnMock.mockReturnValue(fakeChild)

      const promise = runPgRestore(CONNECTION_STRING, Buffer.from('SELECT 1;'))

      const epipe = createEpipeError()
      fakeChild.stderr.emit('error', epipe)

      await expect(promise).rejects.toBeInstanceOf(PgProcessError)
      await expect(promise).rejects.toMatchObject({
        message: expect.stringContaining('psql restore: stderr read failed'),
      })
      await expect(promise).rejects.toMatchObject({
        message: expect.stringContaining('EPIPE'),
      })
    }
  )

  it(
    "does not re-settle when child.stdout emits 'error' after 'close' already settled the " +
      'promise (AC4/AC8 race test — the new stream sources fold into the existing settled guard)',
    async () => {
      const { runPgRestore, PgProcessError } = await import('./pg-process.js')
      const fakeChild = createFakeChild()
      spawnMock.mockReturnValue(fakeChild)

      let settleCount = 0
      const promise = runPgRestore(CONNECTION_STRING, Buffer.from('SELECT 1;')).catch((err) => {
        settleCount += 1
        return err
      })

      fakeChild.emit('close', 1)
      fakeChild.stdout.emit('error', createEpipeError())

      const result = await promise
      expect(result).toBeInstanceOf(PgProcessError)
      expect(result.message).toBe(EXIT_CODE_1_MESSAGE)
      expect(settleCount).toBe(1)
    }
  )

  it(
    'settles exactly once when both a stdout error and a stderr error race for the same ' +
      'restore attempt (AC4/AC8 — two of the new sources racing each other, not just against close)',
    async () => {
      const { runPgRestore, PgProcessError } = await import('./pg-process.js')
      const fakeChild = createFakeChild()
      spawnMock.mockReturnValue(fakeChild)

      let settleCount = 0
      const promise = runPgRestore(CONNECTION_STRING, Buffer.from('SELECT 1;')).catch((err) => {
        settleCount += 1
        return err
      })

      fakeChild.stdout.emit('error', createEpipeError())
      fakeChild.stderr.emit('error', createEpipeError())

      const result = await promise
      expect(result).toBeInstanceOf(PgProcessError)
      expect(settleCount).toBe(1)
    }
  )
})
