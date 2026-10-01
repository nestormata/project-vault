/**
 * Story 66.4 AC-7: turns a spawned isolated API's stderr into the one-line reason it refused to
 * start. The API writes exactly one redacted `startup.failed` JSON line on stderr (AC-2); a JSON
 * line can arrive split across `data` chunks, so input is line-buffered. Memory is bounded: only
 * the last relevant values and at most 64 KiB of an unterminated line are kept.
 */

const MAX_PENDING_BYTES = 64 * 1024
const MAX_REASON_CHARS = 500

function startupFailureMessage(line: string): string | undefined {
  if (!line.startsWith('{')) return undefined
  try {
    const parsed: unknown = JSON.parse(line)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const record = parsed as { eventType?: unknown; err?: { message?: unknown } }
    if (record.eventType !== 'startup.failed') return undefined
    return typeof record.err?.message === 'string' ? record.err.message : undefined
  } catch {
    return undefined
  }
}

export class StderrTail {
  private pending = ''
  private lastFailure: string | undefined
  private lastLine: string | undefined

  push(chunk: string): void {
    const lines = (this.pending + chunk).split('\n')
    this.pending = (lines.pop() ?? '').slice(-MAX_PENDING_BYTES)
    for (const line of lines) this.consider(line)
  }

  pendingLength(): number {
    return this.pending.length
  }

  /** err.message of the last startup.failed line, else the last non-empty line, else `no output`. */
  reason(): string {
    const pendingFailure = startupFailureMessage(this.pending.trim())
    const pendingLine = this.pending.trim() === '' ? undefined : this.pending.trim()
    const failure = pendingFailure ?? this.lastFailure
    if (failure !== undefined) return failure
    const line = pendingLine ?? this.lastLine
    return line === undefined ? 'no output' : line.slice(0, MAX_REASON_CHARS)
  }

  private consider(rawLine: string): void {
    const line = rawLine.trim()
    if (line === '') return
    this.lastLine = line
    const failure = startupFailureMessage(line)
    if (failure !== undefined) this.lastFailure = failure
  }
}

export function earlyExitMessage(
  label: string,
  port: number,
  code: number | null,
  signal: NodeJS.Signals | null,
  reason: string
): string {
  return `isolated api ${label}:${port} exited before /health (code=${String(code)}, signal=${String(signal)}): ${reason}`
}
