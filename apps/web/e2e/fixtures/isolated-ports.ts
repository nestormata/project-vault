import { createServer, type Server } from 'node:net'

/**
 * Story 66.10 (DW-422): port allocation for the isolated-stack fixtures. Journeys used to hardcode
 * ports (34719..34928, metrics at port + 1000), all inside the Linux ephemeral range, so any
 * outgoing connection on the machine could hold the number and the child died with EADDRINUSE.
 *
 * Why OS assignment is safe: `listen(0)` binds a port the kernel has verified is free right now,
 * so a port that is already in use is never handed out. The only remaining risk is the window
 * between closing the probe socket and the child binding it (TOCTOU); `withFreshPortRetry` covers
 * that by retrying the spawn on a NEW port, bounded, only for EADDRINUSE.
 */

const MAX_ATTEMPTS = 3

/** Ports this process already handed out: a freed port must not be given to a second caller
 * before the first caller's child has had the chance to bind it. */
const handedOut = new Set<number>()

function listenOnFreePort(): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    // No host: same dual-stack wildcard bind the API uses (`::`), so a port that is free here is
    // free for the child.
    server.listen(0, () => resolve(server))
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

function assignedPort(server: Server): number {
  const address = server.address()
  if (typeof address !== 'object' || address === null) {
    throw new Error('could not read the assigned port')
  }
  return address.port
}

/**
 * Allocates `count` distinct free ports. All probe sockets are held open together, so the ports
 * of one call can never coincide, and none was already handed out by this process.
 */
export async function allocateFreePorts(count: number): Promise<number[]> {
  const servers: Server[] = []
  const ports: number[] = []
  try {
    while (ports.length < count) {
      const server = await listenOnFreePort()
      servers.push(server)
      const port = assignedPort(server)
      if (!handedOut.has(port)) {
        handedOut.add(port)
        ports.push(port)
      }
    }
  } finally {
    await Promise.all(servers.map(closeServer))
  }
  return ports
}

export async function allocateFreePort(): Promise<number> {
  const ports = await allocateFreePorts(1)
  return ports[0] as number
}

/** True for an Error whose message carries the `listen EADDRINUSE` reason from the child. */
export function isAddrInUseFailure(error: unknown): boolean {
  return error instanceof Error && error.message.includes('EADDRINUSE')
}

export type PortAllocation = { port: number; metricsPort: number }

export type FreshPortRetryOptions = {
  /** A restart must reuse its port (the web process points at it): a single attempt, no retry. */
  pinnedPort?: number
  maxAttempts?: number
}

/**
 * Runs `attempt` with an API port and a metrics port. On an EADDRINUSE failure (and only that),
 * retries with freshly allocated ports, at most `maxAttempts` (3) times in total.
 */
export async function withFreshPortRetry<T>(
  attempt: (allocation: PortAllocation) => Promise<T>,
  options: FreshPortRetryOptions = {}
): Promise<T> {
  const maxAttempts = options.pinnedPort === undefined ? (options.maxAttempts ?? MAX_ATTEMPTS) : 1
  let lastError: unknown
  for (let n = 1; n <= maxAttempts; n++) {
    const [port, metricsPort] = (await allocateFreePorts(2)) as [number, number]
    try {
      return await attempt({ port: options.pinnedPort ?? port, metricsPort })
    } catch (error) {
      lastError = error
      if (!isAddrInUseFailure(error)) throw error
    }
  }
  throw lastError
}
