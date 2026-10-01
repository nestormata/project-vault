import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import {
  CHILD_MAX_BUFFER_BYTES,
  CHILD_TIMEOUT_MS,
  checkSurfaceFreshness,
  childEnvironment,
  createSurfaceRunner,
  type SurfaceExecutor,
} from './surface-runner.js'

// Story 66-6: these tests drive the child runner through an injected fake executor. None of
// them spawns a real child, so they stay in the millisecond range under coverage.

const HEADER = '# @project-vault/extension-api public type surface'
const VALID_SNAPSHOT = `${HEADER}\n\n## export \`Foo\`\n\n- since: 1.0.0\n`
const root = '/virtual/extension-api'
// Node 20 has no native type stripping, so the runner uses the tsx loader there.
const TSX_NODE = '20.20.2'
const NATIVE_ARGS = ['tests/api-surface.ts', '--emit']
const TSX_ARGS = ['--import', 'tsx', ...NATIVE_ARGS]

interface ExecFailure extends Error {
  code?: string
  status?: number | null
  signal?: string | null
  stderr?: string
}

function execFailure(fields: Partial<ExecFailure>, message = 'child failed'): ExecFailure {
  return Object.assign(new Error(message), fields)
}

function clock(...ticks: number[]): () => number {
  let index = 0
  return () => ticks[Math.min(index++, ticks.length - 1)] ?? 0
}

function failureOf(run: () => unknown): Error {
  try {
    run()
  } catch (error) {
    return error as Error
  }
  throw new Error('expected the runner to throw')
}

describe('surface runner (child-process generation)', () => {
  it.each([
    ['24.18.0', NATIVE_ARGS],
    ['23.6.0', NATIVE_ARGS],
    ['22.18.0', NATIVE_ARGS],
    ['22.17.1', TSX_ARGS],
    ['23.5.0', TSX_ARGS],
    ['20.20.2', TSX_ARGS],
  ])(
    'on Node %s spawns the emit mode with %j, a bounded timeout and buffer',
    (nodeVersion, expectedArgs) => {
      const calls: Array<{ file: string; args: readonly string[]; options: unknown }> = []
      const execute: SurfaceExecutor = (file, args, options) => {
        calls.push({ file, args, options })
        return VALID_SNAPSHOT
      }
      const runner = createSurfaceRunner({ execute, now: clock(100, 1_943), nodeVersion, env: {} })

      const generation = runner.generate(root)

      expect(generation).toEqual({ snapshot: VALID_SNAPSHOT, durationMs: 1_843 })
      expect(calls).toHaveLength(1)
      expect(calls[0]?.file).toBe(process.execPath)
      expect(calls[0]?.args).toEqual(expectedArgs)
      expect(calls[0]?.options).toMatchObject({
        cwd: root,
        encoding: 'utf8',
        timeout: CHILD_TIMEOUT_MS,
        maxBuffer: CHILD_MAX_BUFFER_BYTES,
      })
      expect(CHILD_TIMEOUT_MS).toBeLessThanOrEqual(12_000)
      expect(CHILD_MAX_BUFFER_BYTES).toBeGreaterThanOrEqual(8 * 1024 * 1024)
    }
  )

  it('memoizes the settled result per root so the full build runs exactly once', () => {
    let builds = 0
    const runner = createSurfaceRunner({
      execute: () => {
        builds += 1
        return VALID_SNAPSHOT
      },
      env: {},
    })

    runner.generate(root)
    runner.generate(root)
    runner.generate(root)

    expect(builds).toBe(1)
    expect(runner.buildCount()).toBe(1)
  })

  it('caches a failed generation too: one spawn, the same error for every caller', () => {
    let builds = 0
    const runner = createSurfaceRunner({
      execute: () => {
        builds += 1
        throw execFailure({ status: 1, stderr: 'boom\n' })
      },
      env: {},
    })

    const first = failureOf(() => runner.generate(root))
    const second = failureOf(() => runner.generate(root))
    const third = failureOf(() => runner.generate(root))

    expect(builds).toBe(1)
    expect(runner.buildCount()).toBe(1)
    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  it('reports a non-zero exit with phase, duration, exit code, command and the stderr tail', () => {
    const stderr = Array.from({ length: 60 }, (_, index) => `stderr line ${index + 1}`).join('\n')
    const runner = createSurfaceRunner({
      execute: () => {
        throw execFailure({ status: 1, signal: null, stderr: `${stderr}\n` })
      },
      now: clock(0, 2_500),
      nodeVersion: TSX_NODE,
      env: {},
    })

    const message = failureOf(() => runner.generate(root)).message

    expect(message).toContain('phase: exit')
    expect(message).toContain('duration: 2500ms')
    expect(message).toContain('exit: code 1')
    expect(message).toContain('command: node --import tsx tests/api-surface.ts --emit')
    expect(message).toContain('stderr line 60')
    expect(message).toContain('stderr line 21')
    expect(message).not.toContain('stderr line 20\n')
    expect(message).toContain('last 40 of 60 stderr lines')
  })

  it('reports a child timeout as the timeout phase with the signal', () => {
    const runner = createSurfaceRunner({
      execute: () => {
        throw execFailure({ code: 'ETIMEDOUT', status: null, signal: 'SIGTERM', stderr: '' })
      },
      now: clock(0, 12_004),
      env: {},
    })

    const message = failureOf(() => runner.generate(root)).message

    expect(message).toContain('phase: timeout')
    expect(message).toContain('duration: 12004ms')
    expect(message).toContain('exit: signal SIGTERM')
    expect(message).toContain(`exceeded ${CHILD_TIMEOUT_MS}ms`)
    expect(message).toContain('stderr: (empty)')
  })

  it('reports a child killed by a signal under the exit phase', () => {
    const runner = createSurfaceRunner({
      execute: () => {
        throw execFailure({ status: null, signal: 'SIGKILL', stderr: 'killed\n' })
      },
      env: {},
    })

    const message = failureOf(() => runner.generate(root)).message

    expect(message).toContain('phase: exit')
    expect(message).toContain('exit: signal SIGKILL')
    expect(message).toContain('killed')
  })

  it('reports oversize output as the parse phase without dumping the output', () => {
    const runner = createSurfaceRunner({
      execute: () => {
        throw execFailure({ code: 'ENOBUFS', status: null, signal: 'SIGTERM', stderr: '' })
      },
      env: {},
    })

    const message = failureOf(() => runner.generate(root)).message

    expect(message).toContain('phase: parse')
    expect(message).toContain(`maxBuffer of ${CHILD_MAX_BUFFER_BYTES} bytes`)
  })

  it('reports a spawn failure and names tsx and the command instead of a bare ENOENT', () => {
    const runner = createSurfaceRunner({
      execute: () => {
        throw execFailure({ code: 'ENOENT' }, 'spawnSync /missing/node ENOENT')
      },
      nodeVersion: TSX_NODE,
      env: {},
    })

    const message = failureOf(() => runner.generate(root)).message

    expect(message).toContain('phase: spawn')
    expect(message).toContain('exit: n/a')
    expect(message).toContain('spawnSync /missing/node ENOENT')
    expect(message).toContain('command: node --import tsx tests/api-surface.ts --emit')
  })

  it('names the native type-stripping command on Node versions that strip types', () => {
    const runner = createSurfaceRunner({
      execute: () => {
        throw execFailure({ status: 1, stderr: 'boom\n' })
      },
      nodeVersion: '24.18.0',
      env: {},
    })

    expect(failureOf(() => runner.generate(root)).message).toContain(
      'command: node tests/api-surface.ts --emit'
    )
  })

  it('adds a tsx install hint when the child cannot load the tsx loader', () => {
    const runner = createSurfaceRunner({
      execute: () => {
        throw execFailure({
          status: 1,
          stderr:
            "node:internal/modules/esm/resolve:873\nError [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from /x\n",
        })
      },
      env: {},
    })

    const message = failureOf(() => runner.generate(root)).message

    expect(message).toContain('hint: tsx could not be loaded')
    expect(message).toContain('devDependency of @project-vault/extension-api')
  })

  it('refuses to spawn on Node older than 20.6 (node --import floor) without calling the executor', () => {
    let builds = 0
    const runner = createSurfaceRunner({
      execute: () => {
        builds += 1
        return VALID_SNAPSHOT
      },
      nodeVersion: '20.5.1',
      env: {},
    })

    const message = failureOf(() => runner.generate(root)).message

    expect(builds).toBe(0)
    expect(message).toContain('phase: spawn')
    expect(message).toContain('Node >= 20.6')
    expect(message).toContain('20.5.1')
  })

  it.each([
    ['empty output', ''],
    ['a child that only prints ok', 'ok\n'],
    ['stdout pollution ahead of the header', `(node:1) ExperimentalWarning: x\n${VALID_SNAPSHOT}`],
    ['no export section', `${HEADER}\n\nnothing exported\n`],
    ['partial output without a trailing newline', `${HEADER}\n\n## export \`Foo\``],
  ])('fails in the parse phase on malformed output: %s', (_label, stdout) => {
    const runner = createSurfaceRunner({ execute: () => stdout, env: {} })

    const message = failureOf(() => runner.generate(root)).message

    expect(message).toContain('phase: parse')
    expect(message).toContain(`${stdout.length} bytes`)
  })

  it('never prints the environment or NODE_OPTIONS in a failure message', () => {
    const runner = createSurfaceRunner({
      execute: () => {
        throw execFailure({ status: 1, stderr: 'nope\n' })
      },
      env: {
        DATABASE_URL: 'postgres://user:hunter2@db/x',
        NODE_OPTIONS: '--max-old-space-size=4096',
      },
    })

    const message = failureOf(() => runner.generate(root)).message

    expect(message).not.toContain('hunter2')
    expect(message).not.toContain('max-old-space-size')
  })
})

describe('child environment', () => {
  // Node's child_process copies the parent's NODE_V8_COVERAGE into the child unless the env
  // passed to spawn has it as an own property, so it is pinned to '' (falsy: coverage off).
  it('disables NODE_V8_COVERAGE and drops inspector or coverage flags from NODE_OPTIONS', () => {
    const env = childEnvironment({
      PATH: '/usr/bin',
      NODE_V8_COVERAGE: '/tmp/66-6-cov',
      NODE_OPTIONS: '--max-old-space-size=4096 --inspect-brk=9229 --experimental-test-coverage',
    })

    expect(env).toEqual({
      PATH: '/usr/bin',
      NODE_OPTIONS: '--max-old-space-size=4096',
      NODE_V8_COVERAGE: '',
    })
  })

  it('removes NODE_OPTIONS entirely when nothing is left after filtering', () => {
    expect(childEnvironment({ NODE_OPTIONS: '--inspect' })).toEqual({ NODE_V8_COVERAGE: '' })
  })

  it('passes the rest of the parent environment through', () => {
    expect(childEnvironment({ HOME: '/home/x' })).toEqual({ HOME: '/home/x', NODE_V8_COVERAGE: '' })
  })
})

describe('checkSurfaceFreshness', () => {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url))

  it('fails, and never passes or skips, when the executor throws', () => {
    const runner = createSurfaceRunner({
      execute: () => {
        throw execFailure({ status: 1, stderr: 'could not load extension-api src/index.ts\n' })
      },
      env: {},
    })

    expect(() => checkSurfaceFreshness(packageRoot, runner)).toThrow(
      /phase: exit[\s\S]*could not load extension-api src\/index\.ts/
    )
    expect(() => checkSurfaceFreshness(packageRoot, runner)).toThrow(/phase: exit/)
    expect(runner.buildCount()).toBe(1)
  })

  it('adds the compare phase, the child duration and the exit code to a contract mismatch', () => {
    const runner = createSurfaceRunner({
      execute: () => `${HEADER}\n\n## export \`DriftProbe\`\n\n- since: 1.0.0\n`,
      now: clock(0, 1_234),
      env: {},
    })

    const result = checkSurfaceFreshness(packageRoot, runner)

    expect(result.ok).toBe(false)
    const errors = result.ok ? [] : result.errors
    expect(errors).toContain(
      'public contract changed: update api-surface.snapshot.md and classify the change against AC-2'
    )
    expect(errors.join('\n')).toContain('phase: compare (child generated in 1234ms, exit code 0)')
    expect(errors.join('\n')).toContain('+ ## export `DriftProbe`')
  })
})
