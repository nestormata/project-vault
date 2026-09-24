import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { runVersionCheck } from './version-check.js'

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
