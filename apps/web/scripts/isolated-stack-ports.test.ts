// @vitest-environment node
import { EventEmitter } from 'node:events'
import { createServer } from 'node:net'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import {
  allocateFreePorts,
  isAddrInUseFailure,
  withFreshPortRetry,
} from '../e2e/fixtures/isolated-ports.js'
import { waitForIsolatedApiReady } from '../e2e/fixtures/isolated-readiness.js'
import { StderrTail } from '../e2e/fixtures/isolated-api-exit.js'

/**
 * Story 66.10 (DW-422): the logic of the isolated-stack fixture that used to hardcode ports in the
 * ephemeral range and could return a dead child. Real process behaviour is proven by the story's
 * `make e2e` runs; these tests pin the allocation, retry, readiness and cleanup rules.
 */

function listen(port: number): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, () => resolve(server))
  })
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

type FakeChild = ChildProcess & { finish: (code: number | null) => void }

function fakeChild(): FakeChild {
  const emitter = new EventEmitter() as unknown as FakeChild
  Object.assign(emitter, { exitCode: null, signalCode: null, pid: 4242 })
  emitter.finish = (code) => {
    Object.assign(emitter, { exitCode: code })
    emitter.emit('close', code, null)
  }
  return emitter
}

describe('allocateFreePorts', () => {
  it('returns distinct, bindable ports across many concurrent calls', async () => {
    const batches = await Promise.all(Array.from({ length: 20 }, () => allocateFreePorts(3)))
    const all = batches.flat()
    expect(all).toHaveLength(60)
    for (const batch of batches) expect(new Set(batch).size).toBe(3)
    for (const port of all) {
      expect(Number.isInteger(port)).toBe(true)
      expect(port).toBeGreaterThan(1023)
    }
    const sample = await listen(all[0] as number)
    await closeServer(sample)
  })

  it('never hands out a port that something is currently listening on', async () => {
    const squatter = await listen(0)
    const squatted = (squatter.address() as { port: number }).port
    try {
      const ports = (
        await Promise.all(Array.from({ length: 30 }, () => allocateFreePorts(2)))
      ).flat()
      expect(ports).not.toContain(squatted)
    } finally {
      await closeServer(squatter)
    }
  })
})

describe('withFreshPortRetry', () => {
  const addrInUse = () =>
    new Error('isolated api x:1 exited before /health (code=1): listen EADDRINUSE: :::1')

  it('retries an EADDRINUSE failure on a NEW port, never the same one', async () => {
    const seen: number[] = []
    const result = await withFreshPortRetry(async ({ port }) => {
      seen.push(port)
      if (seen.length < 3) throw addrInUse()
      return port
    })
    expect(seen).toHaveLength(3)
    expect(new Set(seen).size).toBe(3)
    expect(result).toBe(seen[2])
  })

  it('gives up after 3 attempts and rethrows the last error', async () => {
    const attempt = vi.fn(async () => {
      throw addrInUse()
    })
    await expect(withFreshPortRetry(attempt)).rejects.toThrow(/EADDRINUSE/)
    expect(attempt).toHaveBeenCalledTimes(3)
  })

  it('does not retry any failure other than EADDRINUSE', async () => {
    const attempt = vi.fn(async () => {
      throw new Error('startup.failed: bad config')
    })
    await expect(withFreshPortRetry(attempt)).rejects.toThrow(/bad config/)
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('with a caller-pinned port (a restart) makes a single attempt on that port', async () => {
    const attempt = vi.fn(async () => {
      throw addrInUse()
    })
    await expect(withFreshPortRetry(attempt, { pinnedPort: 4321 })).rejects.toThrow(/EADDRINUSE/)
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(attempt).toHaveBeenCalledWith(expect.objectContaining({ port: 4321 }))
  })

  it('recognises EADDRINUSE only', () => {
    expect(isAddrInUseFailure(addrInUse())).toBe(true)
    expect(isAddrInUseFailure(new Error('ECONNREFUSED'))).toBe(false)
    expect(isAddrInUseFailure('EADDRINUSE')).toBe(false)
  })
})

describe('waitForIsolatedApiReady', () => {
  const base = (child: ChildProcess, overrides: Record<string, unknown> = {}) => ({
    child,
    label: 'api-test',
    port: 1234,
    stderrTail: new StderrTail(),
    probeHealth: async () => undefined,
    confirmIdentity: async () => true,
    stop: async () => undefined,
    identityGraceMs: 20,
    ...overrides,
  })

  it('resolves when /health answers, the child is alive and it is the child that answered', async () => {
    await expect(waitForIsolatedApiReady(base(fakeChild()))).resolves.toBeUndefined()
  })

  it('fails when a STALE process answers /health while the child dies of EADDRINUSE', async () => {
    const child = fakeChild()
    const stderrTail = new StderrTail()
    stderrTail.push('listen EADDRINUSE: address already in use :::1234\n')
    const ready = waitForIsolatedApiReady(
      base(child, { stderrTail, confirmIdentity: async () => false })
    )
    setTimeout(() => child.finish(1), 5)
    await expect(ready).rejects.toThrow(/exited before \/health.*EADDRINUSE/)
  })

  it('fails when the child had already exited by the time /health answered', async () => {
    const child = fakeChild()
    child.finish(1)
    await expect(waitForIsolatedApiReady(base(child))).rejects.toThrow(/exited before \/health/)
  })

  it('stops the child and fails when something else answers and the child never exits', async () => {
    const stop = vi.fn(async () => undefined)
    await expect(
      waitForIsolatedApiReady(base(fakeChild(), { confirmIdentity: async () => false, stop }))
    ).rejects.toThrow(/answered by a different process/)
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('kills the still-running child on a readiness timeout and includes its logs', async () => {
    const stop = vi.fn(async () => undefined)
    const stderrTail = new StderrTail()
    stderrTail.push('migrating schema...\n')
    const child = fakeChild()
    await expect(
      waitForIsolatedApiReady(
        base(child, {
          stderrTail,
          stop,
          probeHealth: async () => {
            throw new Error('Timed out waiting for the /health probe')
          },
        })
      )
    ).rejects.toThrow(/Timed out waiting.*migrating schema/s)
    expect(stop).toHaveBeenCalledWith(child)
  })
})
