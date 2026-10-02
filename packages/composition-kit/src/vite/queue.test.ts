import { describe, expect, it } from 'vitest'
import { createComposeQueue, type ComposeBatch } from './queue.js'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('createComposeQueue (AC-13: coalescing, single-flight)', () => {
  it('collapses rapid events (a temp file written, then renamed) into one compose', async () => {
    const batches: ComposeBatch[] = []
    const queue = createComposeQueue({
      debounceMs: 5,
      run: async (batch) => {
        batches.push(batch)
      },
    })
    queue.schedule('a.ts')
    queue.schedule('a.ts~')
    queue.schedule('a.ts')
    await queue.idle()
    expect(batches).toEqual([{ paths: ['a.ts', 'a.ts~'], full: false }])
  })

  it('never runs two composes at once: events during a run queue exactly one follow-up', async () => {
    const gate = deferred()
    let running = 0
    let maxRunning = 0
    const batches: ComposeBatch[] = []
    const queue = createComposeQueue({
      debounceMs: 1,
      run: async (batch) => {
        running += 1
        maxRunning = Math.max(maxRunning, running)
        batches.push(batch)
        if (batches.length === 1) await gate.promise
        running -= 1
      },
    })
    queue.schedule('one.ts')
    await new Promise((done) => setTimeout(done, 15))
    queue.schedule('two.ts')
    queue.schedule('three.ts')
    await new Promise((done) => setTimeout(done, 15))
    gate.resolve()
    await queue.idle()
    expect(maxRunning).toBe(1)
    expect(batches).toEqual([
      { paths: ['one.ts'], full: false },
      { paths: ['three.ts', 'two.ts'], full: false },
    ])
  })

  it('asks for a full re-compose when the manifest changed', async () => {
    const batches: ComposeBatch[] = []
    const queue = createComposeQueue({
      debounceMs: 1,
      run: async (batch) => {
        batches.push(batch)
      },
    })
    queue.schedule('pv-ui.manifest.ts', true)
    queue.schedule('x.ts')
    await queue.idle()
    expect(batches).toEqual([{ paths: ['pv-ui.manifest.ts', 'x.ts'], full: true }])
  })

  it('keeps going after a failed compose', async () => {
    let calls = 0
    const queue = createComposeQueue({
      debounceMs: 1,
      run: async () => {
        calls += 1
        if (calls === 1) throw new Error('boom')
      },
      onError: () => undefined,
    })
    queue.schedule('a')
    await queue.idle()
    queue.schedule('b')
    await queue.idle()
    expect(calls).toBe(2)
  })
})
