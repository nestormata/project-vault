import { Writable } from 'node:stream'

export function createLogCaptureStream(): { stream: Writable; lines: string[] } {
  const lines: string[] = []
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString())
      cb()
    },
  })
  return { stream, lines }
}

export function parseCapturedLogLines(lines: string[]): Array<Record<string, unknown>> {
  return lines
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

export async function flushCapturedLogger(logger: unknown): Promise<void> {
  await (logger as { flush?: () => void | Promise<void> }).flush?.()
}
