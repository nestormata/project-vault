import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { createRealPrompt, PromptInterruptedError } from './prompt.js'

/**
 * Story 43.2 — `prompt.ts` shipped with no dedicated test file at all (previously 4.65%
 * statement coverage), even though it implements real, security-relevant terminal behavior: the
 * masked (no-echo) password prompt, Ctrl+C mid-prompt cancellation (AC-2's "interrupt mid-prompt"
 * edge case), and backspace editing. These tests drive both `createRealPrompt()` branches
 * (`mask: false` via real `node:readline/promises`, `mask: true` via the raw-keystroke
 * `promptMasked()` path) against fake `process.stdin`/`process.stdout`, restoring the real
 * globals afterwards.
 */

/** A minimal fake TTY stdin: just enough of the Readable/net.Socket surface `promptMasked()`
 * actually touches (`isTTY`, `isRaw`, `setRawMode`, `resume`, `pause`, `setEncoding`,
 * `on`/`removeListener` via EventEmitter) — not a full stream implementation. */
class FakeTTYStdin extends EventEmitter {
  isTTY = true
  isRaw = false
  setRawMode(mode: boolean): this {
    this.isRaw = mode
    return this
  }
  resume(): this {
    return this
  }
  pause(): this {
    return this
  }
  setEncoding(): this {
    return this
  }
}

function withPatchedProcessStream<K extends 'stdin' | 'stdout'>(
  key: K,
  value: unknown,
  fn: () => Promise<void> | void
): Promise<void> | void {
  const original = Object.getOwnPropertyDescriptor(process, key)
  Object.defineProperty(process, key, { value, configurable: true })
  const restore = () => {
    if (original) Object.defineProperty(process, key, original)
  }
  const result = fn()
  if (result instanceof Promise) {
    return result.finally(restore)
  }
  restore()
  return result
}

function fakeWritable() {
  const chunks: string[] = []
  return { write: (chunk: string) => (chunks.push(chunk), true), chunks }
}

describe('createRealPrompt — mask: false (readline)', () => {
  it('resolves with the line the user typed, writing the question to stdout', async () => {
    const input = new PassThrough()
    const output = fakeWritable()

    await withPatchedProcessStream('stdin', input, async () => {
      await withPatchedProcessStream('stdout', output, async () => {
        const promptFn = createRealPrompt()
        const resultPromise = promptFn('Email: ', { mask: false })
        input.write('dev@example.com\n')
        await expect(resultPromise).resolves.toBe('dev@example.com')
        expect(output.chunks.join('')).toContain('Email: ')
      })
    })
  })
})

describe('createRealPrompt — mask: true (raw-keystroke, no echo)', () => {
  afterEach(() => {
    // promptMasked() attaches a 'data' listener per call; nothing here needs a manual teardown
    // since each test uses its own fresh FakeTTYStdin instance.
  })

  it('resolves with typed input on Enter and restores raw mode', async () => {
    const stdin = new FakeTTYStdin()
    const output = fakeWritable()

    await withPatchedProcessStream('stdin', stdin, async () => {
      await withPatchedProcessStream('stdout', output, async () => {
        const promptFn = createRealPrompt()
        const resultPromise = promptFn('Password: ', { mask: true })
        expect(stdin.isRaw).toBe(true)
        stdin.emit('data', 'hunter2\n')
        await expect(resultPromise).resolves.toBe('hunter2')
        expect(stdin.isRaw).toBe(false)
        expect(output.chunks.join('')).toContain('Password: ')
      })
    })
  })

  it('applies backspace edits before Enter', async () => {
    const stdin = new FakeTTYStdin()
    const output = fakeWritable()

    await withPatchedProcessStream('stdin', stdin, async () => {
      await withPatchedProcessStream('stdout', output, async () => {
        const promptFn = createRealPrompt()
        const resultPromise = promptFn('Password: ', { mask: true })
        // "hunter3" with the trailing '3' backspaced out and replaced by '2'.
        stdin.emit('data', 'hunter3\u007f2\n')
        await expect(resultPromise).resolves.toBe('hunter2')
      })
    })
  })

  it('a leading backspace on empty input is a no-op, not an underflow', async () => {
    const stdin = new FakeTTYStdin()
    const output = fakeWritable()

    await withPatchedProcessStream('stdin', stdin, async () => {
      await withPatchedProcessStream('stdout', output, async () => {
        const promptFn = createRealPrompt()
        const resultPromise = promptFn('Password: ', { mask: true })
        stdin.emit('data', '\u007fok\n')
        await expect(resultPromise).resolves.toBe('ok')
      })
    })
  })

  it('rejects with PromptInterruptedError on Ctrl+C and restores raw mode', async () => {
    const stdin = new FakeTTYStdin()
    const output = fakeWritable()

    await withPatchedProcessStream('stdin', stdin, async () => {
      await withPatchedProcessStream('stdout', output, async () => {
        const promptFn = createRealPrompt()
        const resultPromise = promptFn('Password: ', { mask: true })
        stdin.emit('data', 'partial\u0003')
        await expect(resultPromise).rejects.toBeInstanceOf(PromptInterruptedError)
        expect(stdin.isRaw).toBe(false)
      })
    })
  })

  it('does not call setRawMode when stdin is not a TTY', async () => {
    const stdin = new FakeTTYStdin()
    stdin.isTTY = false
    const output = fakeWritable()
    let setRawModeCalled = false
    stdin.setRawMode = (() => {
      setRawModeCalled = true
      return stdin
    }) as unknown as FakeTTYStdin['setRawMode']

    await withPatchedProcessStream('stdin', stdin, async () => {
      await withPatchedProcessStream('stdout', output, async () => {
        const promptFn = createRealPrompt()
        const resultPromise = promptFn('Password: ', { mask: true })
        stdin.emit('data', 'x\n')
        await expect(resultPromise).resolves.toBe('x')
        expect(setRawModeCalled).toBe(false)
      })
    })
  })
})

describe('PromptInterruptedError', () => {
  it('carries a descriptive message and name', () => {
    const error = new PromptInterruptedError()
    expect(error.name).toBe('PromptInterruptedError')
    expect(error.message).toMatch(/SIGINT/)
    expect(error).toBeInstanceOf(Error)
  })
})
