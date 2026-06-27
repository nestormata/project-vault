import { describe, expect, it, vi } from 'vitest'
import {
  createLogCaptureStream,
  flushCapturedLogger,
  parseCapturedLogLines,
} from './capture-logs.js'

describe('capture log helpers', () => {
  it('captures and parses newline-delimited JSON logs deterministically', () => {
    const { stream, lines } = createLogCaptureStream()

    stream.write('{"eventType":"test.one"}\n{"eventType":"test.two"}\n')

    expect(lines).toEqual(['{"eventType":"test.one"}\n{"eventType":"test.two"}\n'])
    expect(parseCapturedLogLines(lines)).toEqual([
      { eventType: 'test.one' },
      { eventType: 'test.two' },
    ])
  })

  it('flushes loggers only when a flush method is available', async () => {
    const flush = vi.fn()

    await flushCapturedLogger({ flush })
    await flushCapturedLogger({})

    expect(flush).toHaveBeenCalledOnce()
  })
})
