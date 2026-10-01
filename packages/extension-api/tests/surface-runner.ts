import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { assertSurfaceSnapshotIsFresh } from './api-surface.js'

/*
 * Story 66-6: single-build child runner for the public-surface snapshot guard.
 *
 * Why a child process, and why exactly once:
 * - The real surface program parses ~259 files (TypeScript libs, @types/node, src). Inside the
 *   vitest worker it runs under V8 coverage, which instruments the 9 MB TypeScript compiler and
 *   makes the build ~4x slower. Under nightly's CPU contention that pushed the first build past
 *   the 15 s test budget (15.5-17.8 s). A child process is a separate isolate that the parent's
 *   coverage does not instrument.
 * - TypeScript renders well-known-symbol members of RegExp with process-global symbol ids
 *   (`__@match@202`). A SECOND program built in the same process renders different ids
 *   (`__@match@1450`), so it no longer equals the committed snapshot (DW-310). The generation must
 *   therefore never run twice in one process. Each child builds one program, first in its
 *   process, which makes the ids stable by construction. Never add an in-process fallback here.
 *
 * The child only generates; the parent reads the committed snapshot and compares
 * (assertSurfaceSnapshotIsFresh), so a child that prints nothing or "ok" can never pass.
 *
 * `node --import <specifier>` needs Node >= 20.6; tsx is the TS loader because Node 20 cannot
 * strip types natively. tsx is an explicit devDependency of this package.
 */

export const CHILD_TIMEOUT_MS = 12_000
export const CHILD_MAX_BUFFER_BYTES = 16 * 1024 * 1024
const CHILD_ARGS = ['--import', 'tsx', 'tests/api-surface.ts', '--emit'] as const
const COMMAND_LABEL = `node ${CHILD_ARGS.join(' ')}`
const SNAPSHOT_HEADER = '# @project-vault/extension-api public type surface'
const MAX_STDERR_LINES = 40
const MIN_NODE = { major: 20, minor: 6 }

export type SurfacePhase = 'spawn' | 'timeout' | 'exit' | 'parse' | 'compare'

export interface SurfaceExecOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  encoding: 'utf8'
  timeout: number
  maxBuffer: number
  stdio: ['ignore', 'pipe', 'pipe']
}

/** Same contract as `execFileSync` with `encoding: 'utf8'`: returns stdout or throws. */
export type SurfaceExecutor = (
  file: string,
  args: readonly string[],
  options: SurfaceExecOptions
) => string

export interface SurfaceGeneration {
  snapshot: string
  durationMs: number
}

export interface SurfaceRunner {
  generate(root: string): SurfaceGeneration
  buildCount(): number
}

export interface SurfaceRunnerOptions {
  execute?: SurfaceExecutor
  now?: () => number
  nodeVersion?: string
  env?: NodeJS.ProcessEnv
}

interface ChildFailure {
  message?: string
  code?: string
  status?: number | null
  signal?: string | null
  stderr?: string | Buffer
}

interface FailureDetails {
  phase: SurfacePhase
  durationMs: number
  exit: string
  reason: string
  stderr?: string
}

const defaultExecutor: SurfaceExecutor = (file, args, options) => execFileSync(file, args, options)

const DROPPED_NODE_OPTION = /^--(inspect|experimental-test-coverage|cpu-prof|heap-prof)/

/**
 * The parent environment minus anything that would re-instrument or debug the child.
 *
 * NODE_V8_COVERAGE is pinned to '' rather than deleted: Node's child_process copies the parent
 * process's NODE_V8_COVERAGE into the child's env unless the passed env has the key as an own
 * property, and an empty value is falsy, which leaves coverage off in the child.
 */
export function childEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { NODE_V8_COVERAGE: _coverage, NODE_OPTIONS: nodeOptions, ...rest } = env
  const kept = (nodeOptions ?? '')
    .split(/\s+/)
    .filter((option) => option.length > 0 && !DROPPED_NODE_OPTION.test(option))
  const options = kept.length > 0 ? { NODE_OPTIONS: kept.join(' ') } : {}
  return { ...rest, ...options, NODE_V8_COVERAGE: '' }
}

function stderrTail(stderr: string | undefined): string {
  const lines = (stderr ?? '').split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length === 0) return 'stderr: (empty)'
  const tail = lines.slice(-MAX_STDERR_LINES)
  return [`stderr (last ${tail.length} of ${lines.length} stderr lines):`, ...tail].join('\n')
}

function hintFor(stderr: string | undefined): string[] {
  const text = stderr ?? ''
  return /ERR_MODULE_NOT_FOUND|Cannot find (package|module)/.test(text) && text.includes('tsx')
    ? [
        'hint: tsx could not be loaded; it must be installed as a devDependency of @project-vault/extension-api (run pnpm install)',
      ]
    : []
}

function formatFailure(root: string, details: FailureDetails): string {
  return [
    `[api-surface] child surface generation failed: ${details.reason}`,
    `phase: ${details.phase}`,
    `duration: ${details.durationMs}ms`,
    `exit: ${details.exit}`,
    `command: ${COMMAND_LABEL} (cwd ${root})`,
    ...hintFor(details.stderr),
    stderrTail(details.stderr),
  ].join('\n')
}

function exitLabel(failure: ChildFailure): string {
  if (typeof failure.status === 'number') return `code ${failure.status}`
  if (failure.signal) return `signal ${failure.signal}`
  return 'n/a'
}

function classify(failure: ChildFailure, durationMs: number): FailureDetails {
  const stderr = failure.stderr === undefined ? undefined : String(failure.stderr)
  const base = { durationMs, exit: exitLabel(failure), stderr }
  if (failure.code === 'ETIMEDOUT')
    return { ...base, phase: 'timeout', reason: `child exceeded ${CHILD_TIMEOUT_MS}ms` }
  if (failure.code === 'ENOBUFS')
    return {
      ...base,
      phase: 'parse',
      reason: `child output exceeded the maxBuffer of ${CHILD_MAX_BUFFER_BYTES} bytes`,
    }
  if (typeof failure.status === 'number' || failure.signal)
    return { ...base, phase: 'exit', reason: 'child exited unsuccessfully' }
  return { ...base, phase: 'spawn', reason: failure.message ?? 'could not start the child' }
}

function malformedReason(stdout: string): string | undefined {
  if (!stdout.startsWith(`${SNAPSHOT_HEADER}\n`)) return 'output does not start with the header'
  if (!stdout.includes('\n## export ')) return 'output has no `## export` section'
  if (!stdout.endsWith('\n')) return 'output does not end with a newline'
  return undefined
}

function nodeVersionTooOld(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number)
  return major < MIN_NODE.major || (major === MIN_NODE.major && minor < MIN_NODE.minor)
}

type Settled = { ok: true; value: SurfaceGeneration } | { ok: false; error: Error }

export function createSurfaceRunner(options: SurfaceRunnerOptions = {}): SurfaceRunner {
  const execute = options.execute ?? defaultExecutor
  const now = options.now ?? (() => performance.now())
  const nodeVersion = options.nodeVersion ?? process.versions.node
  const env = options.env ?? process.env
  // Module-scoped per runner (never globalThis, never on disk), so watch-mode reruns rebuild.
  const settled = new Map<string, Settled>()
  let builds = 0

  function run(root: string): SurfaceGeneration {
    if (nodeVersionTooOld(nodeVersion))
      throw new Error(
        formatFailure(root, {
          phase: 'spawn',
          durationMs: 0,
          exit: 'n/a',
          reason: `node --import requires Node >= ${MIN_NODE.major}.${MIN_NODE.minor}; running ${nodeVersion}`,
        })
      )
    const started = now()
    let stdout: string
    builds += 1
    try {
      stdout = execute(process.execPath, CHILD_ARGS, {
        cwd: root,
        env: childEnvironment(env),
        encoding: 'utf8',
        timeout: CHILD_TIMEOUT_MS,
        maxBuffer: CHILD_MAX_BUFFER_BYTES,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      throw new Error(
        formatFailure(root, classify(error as ChildFailure, Math.round(now() - started)))
      )
    }
    const durationMs = Math.round(now() - started)
    const malformed = malformedReason(stdout)
    if (malformed)
      throw new Error(
        formatFailure(root, {
          phase: 'parse',
          durationMs,
          exit: 'code 0',
          reason: `${malformed} (${stdout.length} bytes of stdout)`,
        })
      )
    return { snapshot: stdout, durationMs }
  }

  return {
    generate(root) {
      let outcome = settled.get(root)
      if (!outcome) {
        try {
          outcome = { ok: true, value: run(root) }
        } catch (error) {
          outcome = { ok: false, error: error as Error }
        }
        settled.set(root, outcome)
      }
      if (!outcome.ok) throw outcome.error
      return outcome.value
    },
    buildCount: () => builds,
  }
}

/** Freshness check over the runner's single generation, with compare-phase context on mismatch. */
export function checkSurfaceFreshness(
  root: string,
  runner: SurfaceRunner
): { ok: true } | { ok: false; errors: string[] } {
  const generation = runner.generate(root)
  const result = assertSurfaceSnapshotIsFresh(root, generation.snapshot)
  if (result.ok) return result
  return {
    ok: false,
    errors: [
      ...result.errors,
      `phase: compare (child generated in ${generation.durationMs}ms, exit code 0)`,
    ],
  }
}
