import { createServer, type Server, type ServerResponse } from 'node:http'
import {
  createServer as createTcpServer,
  type AddressInfo,
  type Server as TcpServer,
  type Socket,
} from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  runVersionCheck,
  VERSION_CHECK_TIMEOUT_MS,
  type RunVersionCheckOptions,
} from './version-check.js'

/**
 * Story 43.6 — against a real local HTTP server: an error response whose body never ends must not
 * keep the connection (and so the pvault process) alive after the check has returned.
 */

type Streaming = { server: Server; baseUrl: string; closed: Promise<void> }

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

async function endlessBodyServer(status: number): Promise<Streaming> {
  let markClosed: () => void = () => undefined
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve
  })
  const server = createServer((_req, res: ServerResponse) => {
    res.writeHead(status, { 'content-type': 'text/plain' })
    const timer = setInterval(() => res.write('x'.repeat(64)), 20)
    res.on('close', () => {
      clearInterval(timer)
      markClosed()
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  return { server, baseUrl: `http://127.0.0.1:${port}`, closed }
}

function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ])
}

describe('runVersionCheck — endless error body (AC-3)', () => {
  it.each([404, 500, 503])(
    '%i with a never-ending body → returns promptly and the connection is closed',
    async (status) => {
      const { baseUrl, closed } = await endlessBodyServer(status)
      const started = Date.now()
      const result = await runVersionCheck({
        baseUrl,
        cliVersion: '1.2.0',
        fetchFn: fetch,
        now: () => Date.now(),
        cacheDir: null,
        writeStderr: () => undefined,
        suppressNotices: false,
      })
      expect(result).toEqual({ refuse: false })
      expect(Date.now() - started).toBeLessThan(1500)
      expect(await settlesWithin(closed, 1000)).toBe(true)
    }
  )
})

/**
 * Story 43.28 AC-6 (R1a): the check's result never waits on transport teardown, and the teardown
 * still happens. Event-order and handle assertions only, never a wall-clock budget.
 */
function checkOptions(baseUrl: string, fetchFn: typeof fetch): RunVersionCheckOptions {
  return {
    baseUrl,
    cliVersion: '1.2.0',
    fetchFn,
    now: () => Date.now(),
    cacheDir: null,
    writeStderr: () => undefined,
    suppressNotices: true,
  }
}

/** Never resolves; records when its abort signal fires. */
function hangingFetch(onAbort: () => void): typeof fetch {
  return ((_url: string, init?: RequestInit) => {
    init?.signal?.addEventListener('abort', onAbort)
    return new Promise<Response>(() => undefined)
  }) as unknown as typeof fetch
}

describe('runVersionCheck: the result settles before teardown (Story 43.28 AC-6 R1a)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves the result first, then aborts the request (test 11)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate'] })
    const order: string[] = []
    const pending = runVersionCheck(
      checkOptions(
        'http://127.0.0.1:9',
        hangingFetch(() => order.push('abort'))
      )
    ).then((result) => {
      order.push('result')
      return result
    })
    await vi.advanceTimersByTimeAsync(VERSION_CHECK_TIMEOUT_MS)
    await vi.runAllTimersAsync()
    expect(await pending).toEqual({ refuse: false })
    expect(order).toEqual(['result', 'abort'])
  })

  it('a teardown hook that never completes does not hold the result (test 2)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate'] })
    let aborted = false
    const fetchFn = hangingFetch(() => {
      aborted = true
      void new Promise(() => undefined)
    })
    let settled = false
    const pending = runVersionCheck(checkOptions('http://127.0.0.1:9', fetchFn)).then((r) => {
      settled = true
      return r
    })
    await vi.advanceTimersByTimeAsync(VERSION_CHECK_TIMEOUT_MS)
    expect(settled).toBe(true)
    expect(await pending).toEqual({ refuse: false })
    await vi.runAllTimersAsync()
    expect(aborted).toBe(true)
  })
})

type HungServer = {
  baseUrl: string
  accepted: Socket[]
  bytesBy: Map<Socket, number>
  server: TcpServer
}

const tcpServers: TcpServer[] = []
afterEach(async () => {
  for (const server of tcpServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

/** Accepts and reads, never writes: the "server that never answers" of DW-426 item 1. */
async function hungServer(): Promise<HungServer> {
  const accepted: Socket[] = []
  const bytesBy = new Map<Socket, number>()
  const server = createTcpServer((socket) => {
    accepted.push(socket)
    bytesBy.set(socket, 0)
    socket.on('data', (chunk: Buffer) =>
      bytesBy.set(socket, (bytesBy.get(socket) ?? 0) + chunk.length)
    )
    socket.on('error', () => undefined)
  })
  tcpServers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${port}`, accepted, bytesBy, server }
}

function tcpSocketHandles(): number {
  return process.getActiveResourcesInfo().filter((name) => name === 'TCPSocketWrap').length
}

async function allClosed(sockets: Socket[], graceMs: number): Promise<boolean> {
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline) {
    if (sockets.every((socket) => socket.closed)) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return sockets.every((socket) => socket.closed)
}

describe('runVersionCheck against a server that never answers (Story 43.28 AC-6)', () => {
  it('leaves no client socket behind once its connections have closed (test 3)', async () => {
    const hung = await hungServer()
    const before = tcpSocketHandles()
    const result = await runVersionCheck(checkOptions(hung.baseUrl, fetch))
    expect(result).toEqual({ refuse: false })
    expect(hung.accepted.length).toBeGreaterThan(0)
    expect(await allClosed(hung.accepted, 2000)).toBe(true)
    expect(tcpSocketHandles()).toBe(before)
  })

  // With fetch, undici reconnects once after an abort: that connection sends zero bytes (no
  // request) and, when two checks share one process, idles in undici's pool until its keep-alive
  // timeout (~4 s) without holding the process open. Every connection that carried a request closes.
  it('two checks in parallel both resolve; every request-carrying connection closes (T14)', async () => {
    const hung = await hungServer()
    const results = await Promise.all([
      runVersionCheck(checkOptions(hung.baseUrl, fetch)),
      runVersionCheck(checkOptions(hung.baseUrl, fetch)),
    ])
    expect(results).toEqual([{ refuse: false }, { refuse: false }])
    const requests = hung.accepted.filter((socket) => (hung.bytesBy.get(socket) ?? 0) > 0)
    expect(requests).toHaveLength(2)
    expect(await allClosed(requests, 2000)).toBe(true)
    const others = hung.accepted.filter((socket) => !requests.includes(socket))
    for (const socket of others) expect(hung.bytesBy.get(socket)).toBe(0)
    for (const socket of others) socket.destroy()
  })

  it('a refused connection resolves without a retry (test 8)', async () => {
    const hung = await hungServer()
    await new Promise<void>((resolve) => hung.server.close(() => resolve()))
    tcpServers.splice(tcpServers.indexOf(hung.server), 1)
    const fetchFn = vi.fn(fetch)
    const result = await runVersionCheck(checkOptions(hung.baseUrl, fetchFn as typeof fetch))
    expect(result).toEqual({ refuse: false })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(hung.accepted).toEqual([])
  })
})
