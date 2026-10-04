#!/usr/bin/env node
// Story 68.10 AC-2.5: pre-allocates N loopback host ports for ONE e2e stack run. The base compose
// file bakes the web host port into ORIGIN / CORS_ALLOWED_ORIGINS / WEB_BASE_URL at `up` time, so the
// ports must be known before it and an OS-assigned publish plus `docker compose port` afterwards
// cannot work. Technique of apps/web/e2e/fixtures/isolated-ports.ts: `listen(0)` makes the kernel
// hand out a port that is free right now (all N probe sockets are open at once, so no port is handed
// out twice), then every port is probed again, because the number can be taken between the probe and
// `docker compose up` (TOCTOU). A port that is no longer bindable triggers a bounded re-allocation
// (3 attempts); after that the script exits non-zero naming the port, never falling back to a fixed
// one.
//
//   node scripts/e2e-free-ports.mjs <count>     prints the ports, space separated, on one line
import { createServer } from 'node:net'

const MAX_ATTEMPTS = 3
const HOST = '127.0.0.1'

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', (error) => reject(Object.assign(error, { port })))
    server.listen(port, HOST, () => resolve(server))
  })
}

const close = (server) => new Promise((resolve) => server.close(() => resolve()))

/** N distinct ports the kernel has verified free (probe sockets all open at once). */
async function allocate(count) {
  const servers = await Promise.all(Array.from({ length: count }, () => listen(0)))
  const ports = servers.map((server) => server.address().port)
  await Promise.all(servers.map(close))
  return ports
}

/** The first of `ports` that cannot be bound right now, or null. */
async function firstTaken(ports) {
  const results = await Promise.allSettled(ports.map((port) => listen(port)))
  const taken = ports.find((_, index) => results.at(index)?.status === 'rejected') ?? null
  await Promise.all(
    results.flatMap((result) => (result.status === 'fulfilled' ? [close(result.value)] : []))
  )
  return taken
}

async function attemptsFrom(attempt, count, lastTaken) {
  if (attempt > MAX_ATTEMPTS) {
    throw new Error(
      `port ${lastTaken} was taken before the stack could use it (${MAX_ATTEMPTS} attempts)`
    )
  }
  const ports = await allocate(count)
  const taken = await firstTaken(ports)
  return taken === null ? ports : attemptsFrom(attempt + 1, count, taken)
}

const count = Number(process.argv[2] ?? 2)
if (!Number.isInteger(count) || count < 1 || count > 8) {
  process.stderr.write('usage: node scripts/e2e-free-ports.mjs <count 1-8>\n')
  process.exit(2)
}
try {
  process.stdout.write(`${(await attemptsFrom(1, count, 0)).join(' ')}\n`)
} catch (error) {
  process.stderr.write(`e2e-free-ports: ${error.message}\n`)
  process.exit(1)
}
