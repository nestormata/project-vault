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
