// A small line diff (Myers' O(ND) algorithm), hand-written so the kit has no dependency for it.

const NO_NEWLINE = String.raw`\ No newline at end of file`
/** Above this edit distance the diff is skipped: a drift report must never hang a build. */
const MAX_EDIT_DISTANCE = 1000
const NUL_PROBE = 8000

type Kind = ' ' | '-' | '+'
interface Op {
  kind: Kind
  line: string
  noEol: boolean
}

function op(kind: Kind, line: string): Op {
  return { kind, line, noEol: false }
}

function splitLines(text: string): { lines: string[]; noEol: boolean } {
  if (text === '') return { lines: [], noEol: false }
  const noEol = !text.endsWith('\n')
  const lines = text.split('\n')
  if (!noEol) lines.pop()
  return { lines, noEol }
}

export function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, NUL_PROBE).includes(0)
}

type Frontier = Map<number, number>

function furthest(v: Frontier, k: number, d: number): number {
  return cameFromAbove(v, k, d) ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1
}

/** The frontier of every edit distance, until the end of both sides is reached; null when the
 * distance exceeds the cap. */
function shortestEdit(a: readonly string[], b: readonly string[]): Frontier[] | null {
  const trace: Frontier[] = []
  let v: Frontier = new Map([[1, 0]])
  for (let d = 0; d <= Math.min(a.length + b.length, MAX_EDIT_DISTANCE); d++) {
    trace.push(new Map(v))
    for (let k = -d; k <= d; k += 2) {
      let x = furthest(v, k, d)
      while (x < a.length && x - k < b.length && a.at(x) === b.at(x - k)) x++
      v.set(k, x)
      if (x >= a.length && x - k >= b.length) return trace
    }
    v = new Map(v)
  }
  return null
}

function cameFromAbove(v: Frontier, k: number, d: number): boolean {
  return k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1))
}

interface Point {
  x: number
  y: number
}

/** One edit distance back: the matched lines (diagonal) then the single insert or delete. */
function stepBack(
  v: Frontier,
  d: number,
  at: Point,
  a: readonly string[],
  b: readonly string[],
  ops: Op[]
): Point {
  const k = at.x - at.y
  const prevK = cameFromAbove(v, k, d) ? k + 1 : k - 1
  const prevX = v.get(prevK) ?? 0
  const prevY = prevX - prevK
  const point = { ...at }
  for (; point.x > prevX && point.y > prevY; point.x--, point.y--)
    ops.push(op(' ', a.at(point.x - 1) ?? ''))
  if (d > 0) {
    ops.push(
      point.x === prevX ? op('+', b.at(point.y - 1) ?? '') : op('-', a.at(point.x - 1) ?? '')
    )
  }
  return { x: prevX, y: prevY }
}

function backtrack(trace: readonly Frontier[], a: readonly string[], b: readonly string[]): Op[] {
  const ops: Op[] = []
  let at: Point = { x: a.length, y: b.length }
  for (let d = trace.length - 1; d >= 0; d--) {
    at = stepBack(trace.at(d) ?? new Map<number, number>(), d, at, a, b, ops)
  }
  return ops.reverse()
}

function hunkRanges(ops: readonly Op[], context: number): [number, number][] {
  const ranges: [number, number][] = []
  ops.forEach((entry, index) => {
    if (entry.kind === ' ') return
    const from = Math.max(0, index - context)
    const to = Math.min(ops.length - 1, index + context)
    const last = ranges.at(-1)
    if (last !== undefined && from <= last[1] + 1) last[1] = to
    else ranges.push([from, to])
  })
  return ranges
}

function count(ops: readonly Op[], skip: Kind): number {
  return ops.filter((entry) => entry.kind !== skip).length
}

function renderHunk(ops: readonly Op[], from: number, to: number): string[] {
  const before = ops.slice(0, from)
  const slice = ops.slice(from, to + 1)
  const oldCount = count(slice, '+')
  const newCount = count(slice, '-')
  const oldStart = count(before, '+') + (oldCount === 0 ? 0 : 1)
  const newStart = count(before, '-') + (newCount === 0 ? 0 : 1)
  const body = slice.flatMap((entry) => [
    `${entry.kind}${entry.line}`,
    ...(entry.noEol ? [NO_NEWLINE] : []),
  ])
  return [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...body]
}

function lastIndexWhere(ops: readonly Op[], test: (entry: Op) => boolean): number {
  return ops.map(test).lastIndexOf(true)
}

/** Marks the last line of each side that has no trailing newline. When only the final newline
 * differs, the identical last line is shown as a removal and an addition. */
function markMissingNewlines(ops: Op[], oldNoEol: boolean, newNoEol: boolean): Op[] {
  const lastOld = lastIndexWhere(ops, (entry) => entry.kind !== '+')
  const lastNew = lastIndexWhere(ops, (entry) => entry.kind !== '-')
  const result = ops.map((entry, index) => ({
    ...entry,
    noEol: (oldNoEol && index === lastOld) || (newNoEol && index === lastNew),
  }))
  const shared = result.at(lastOld)
  if (oldNoEol !== newNoEol && lastOld === lastNew && shared?.kind === ' ') {
    result.splice(
      lastOld,
      1,
      { kind: '-', line: shared.line, noEol: oldNoEol },
      { kind: '+', line: shared.line, noEol: newNoEol }
    )
  }
  return result
}

/** A unified diff of two texts, empty when they are identical. */
export function unifiedDiff(
  oldText: string,
  newText: string,
  oldLabel: string,
  newLabel: string,
  context = 3
): string {
  if (oldText === newText) return ''
  const oldSide = splitLines(oldText)
  const newSide = splitLines(newText)
  const trace = shortestEdit(oldSide.lines, newSide.lines)
  const head = [`--- ${oldLabel}`, `+++ ${newLabel}`]
  if (trace === null) {
    const notice = `(files too large to diff: ${oldSide.lines.length} and ${newSide.lines.length} lines)`
    return `${[...head, notice].join('\n')}\n`
  }
  const ops = markMissingNewlines(
    backtrack(trace, oldSide.lines, newSide.lines),
    oldSide.noEol,
    newSide.noEol
  )
  const hunks = hunkRanges(ops, context).flatMap(([from, to]) => renderHunk(ops, from, to))
  return `${[...head, ...hunks].join('\n')}\n`
}

/** Diffs two files' bytes; binary files are reported, never dumped. */
export function diffFiles(
  oldBytes: Uint8Array,
  newBytes: Uint8Array,
  oldLabel: string,
  newLabel: string
): string {
  if (isBinary(oldBytes) || isBinary(newBytes)) {
    return `Binary files ${oldLabel} and ${newLabel} differ\n`
  }
  return unifiedDiff(
    Buffer.from(oldBytes).toString('utf8'),
    Buffer.from(newBytes).toString('utf8'),
    oldLabel,
    newLabel
  )
}
