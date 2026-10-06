/**
 * Story 65.4 AC3 — pure statistics behind `external-timing.integration.test.ts`. No I/O.
 *
 * Method: medians (heavy right tails from GC and the scheduler make means unusable), a seeded
 * percentile bootstrap of the median difference (no normality assumption, replayable from the
 * printed seed), and a three-way pass / fail / inconclusive decision so a run only FAILS when it is
 * confident a difference exceeds the tolerance T. A run whose A/A control differs by more than T,
 * or whose positive control is not detected, is reported INVALID and never as a pass.
 */

export type Rng = () => number

/** Small, fast, seedable PRNG (public-domain mulberry32). */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fisher-Yates on a copy. */
export function seededShuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    const atI = out.at(i) as T
    const atJ = out.at(j) as T
    out.splice(i, 1, atJ)
    out.splice(j, 1, atI)
  }
  return out
}

function sorted(xs: readonly number[]): number[] {
  if (xs.length === 0) throw new Error('cannot summarise an empty sample')
  return [...xs].sort((a, b) => a - b)
}

export function median(xs: readonly number[]): number {
  const s = sorted(xs)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1
    ? (s.at(mid) as number)
    : ((s.at(mid - 1) as number) + (s.at(mid) as number)) / 2
}

/** Nearest-rank percentile, `p` in [0, 1]. */
export function percentile(xs: readonly number[], p: number): number {
  const s = sorted(xs)
  const rank = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))
  return s.at(rank) as number
}

export type DeltaCI = { delta: number; lo: number; hi: number }

function resample(xs: readonly number[], rng: Rng): number[] {
  return Array.from({ length: xs.length }, () => xs.at(Math.floor(rng() * xs.length)) as number)
}

/** Percentile-bootstrap CI of `median(a) - median(b)`. */
export function bootstrapMedianDeltaCI(
  a: readonly number[],
  b: readonly number[],
  opts: { resamples: number; confidence: number; rng: Rng }
): DeltaCI {
  const deltas = Array.from(
    { length: opts.resamples },
    () => median(resample(a, opts.rng)) - median(resample(b, opts.rng))
  )
  const tail = (1 - opts.confidence) / 2
  return {
    delta: median(a) - median(b),
    lo: percentile(deltas, tail),
    hi: percentile(deltas, 1 - tail),
  }
}

/** Bounds on |delta| implied by a CI on delta: a CI straddling zero has a lower bound of 0. */
export function absDeltaBounds(ci: DeltaCI): { lower: number; upper: number } {
  const upper = Math.max(Math.abs(ci.lo), Math.abs(ci.hi))
  const lower = ci.lo <= 0 && ci.hi >= 0 ? 0 : Math.min(Math.abs(ci.lo), Math.abs(ci.hi))
  return { lower, upper }
}

export type Verdict = 'pass' | 'fail' | 'inconclusive'

/** Fail only when CONFIDENTLY more than T away (either direction: a faster class leaks too);
 *  pass only when confidently within T; otherwise inconclusive. */
export function classifyDelta(ci: DeltaCI, toleranceMs: number): Verdict {
  const { lower, upper } = absDeltaBounds(ci)
  if (lower > toleranceMs) return 'fail'
  if (upper <= toleranceMs) return 'pass'
  return 'inconclusive'
}

/** T = max(T_floor, k x half-width of the A/A (U' vs U) CI): the smallest effect the runner can
 *  reliably resolve. */
export function toleranceFromAA(aa: DeltaCI, opts: { floorMs: number; k: number }): number {
  return Math.max(opts.floorMs, opts.k * ((aa.hi - aa.lo) / 2))
}

export type TimingRow = {
  cls: string
  n: number
  medianMs: number
  p99Ms: number
  ci: DeltaCI
  verdict: Verdict
}

export type TimingValidity =
  | 'valid'
  | 'invalid: A/A failed'
  | 'invalid: positive control not detected'
  | 'invalid: underpowered'

const UNDERPOWERED: TimingValidity = 'invalid: underpowered'

export type TimingEvaluation = {
  toleranceMs: number
  aa: TimingRow
  control: TimingRow
  rows: TimingRow[]
  leaks: string[]
  inconclusive: string[]
  validity: TimingValidity
}

export type TimingEvaluationOptions = {
  floorMs: number
  k: number
  resamples: number
  confidence: number
  maxInconclusive: number
  seed: number
  /** Miss classes compared against `U` (the baseline). `U'` is the A/A control, `H` the positive
   *  control. */
  missClasses: readonly string[]
}

/**
 * Evaluates one measurement. `samples` must contain `U`, `U'`, `H` and every miss class. Validity
 * gates (i) A/A must pass, (ii) H must be fail-shaped, plus the inconclusive cap: a noisy or
 * insensitive run is reported INVALID, never as a pass.
 */
export function evaluateTiming(
  samples: Record<string, readonly number[]>,
  opts: TimingEvaluationOptions
): TimingEvaluation {
  const rng = mulberry32(opts.seed)
  const byClass = new Map(Object.entries(samples))
  const baseline = byClass.get('U')
  if (!baseline) throw new Error('timing samples are missing the U baseline')
  const row = (cls: string, toleranceMs: number): TimingRow => {
    const xs = byClass.get(cls)
    if (!xs) throw new Error(`timing samples are missing class ${cls}`)
    const ci = bootstrapMedianDeltaCI(xs, baseline, {
      resamples: opts.resamples,
      confidence: opts.confidence,
      rng,
    })
    return {
      cls,
      n: xs.length,
      medianMs: median(xs),
      p99Ms: percentile(xs, 0.99),
      ci,
      verdict: classifyDelta(ci, toleranceMs),
    }
  }
  const aaCi = row("U'", Number.POSITIVE_INFINITY).ci
  const toleranceMs = toleranceFromAA(aaCi, { floorMs: opts.floorMs, k: opts.k })
  const aa = { ...row("U'", toleranceMs), ci: aaCi, verdict: classifyDelta(aaCi, toleranceMs) }
  const control = row('H', toleranceMs)
  const rows = opts.missClasses.map((cls) => row(cls, toleranceMs))
  const leaks = rows.filter((r) => r.verdict === 'fail').map((r) => r.cls)
  const inconclusive = rows.filter((r) => r.verdict === 'inconclusive').map((r) => r.cls)
  let validity: TimingValidity = 'valid'
  if (aa.verdict !== 'pass') validity = 'invalid: A/A failed'
  else if (control.verdict !== 'fail') validity = 'invalid: positive control not detected'
  else if (inconclusive.length > opts.maxInconclusive) validity = UNDERPOWERED
  return { toleranceMs, aa, control, rows, leaks, inconclusive, validity }
}

/** Folds a re-sample pass (only the previously inconclusive classes, plus fresh U and U') into the
 *  first pass: re-sampled rows replace their first-pass rows; the re-sample pass's own A/A must also
 *  pass; the inconclusive cap is re-applied to the merged set. */
export function mergeResample(
  first: TimingEvaluation,
  second: TimingEvaluation,
  maxInconclusive: number
): TimingEvaluation {
  const rows = first.rows.map((r) => second.rows.find((s) => s.cls === r.cls) ?? r)
  const leaks = rows.filter((r) => r.verdict === 'fail').map((r) => r.cls)
  const inconclusive = rows.filter((r) => r.verdict === 'inconclusive').map((r) => r.cls)
  let validity: TimingValidity = first.validity
  if (validity === 'valid' || validity === UNDERPOWERED) {
    if (second.aa.verdict !== 'pass') validity = 'invalid: A/A failed'
    else validity = inconclusive.length > maxInconclusive ? UNDERPOWERED : 'valid'
  }
  return { ...first, rows, leaks, inconclusive, validity }
}

/** One table line per class: labels, counts and timings only. */
export function formatTimingTable(evaluation: TimingEvaluation): string {
  const fmt = (r: TimingRow) =>
    `${r.cls.padEnd(3)} n=${String(r.n).padStart(3)} median=${r.medianMs.toFixed(2)}ms p99=${r.p99Ms.toFixed(2)}ms delta=${r.ci.delta.toFixed(2)} CI=[${r.ci.lo.toFixed(2)}, ${r.ci.hi.toFixed(2)}] ${r.verdict}`
  return [
    `T=${evaluation.toleranceMs.toFixed(2)}ms validity=${evaluation.validity}`,
    fmt(evaluation.aa),
    fmt(evaluation.control),
    ...evaluation.rows.map(fmt),
  ].join('\n')
}
