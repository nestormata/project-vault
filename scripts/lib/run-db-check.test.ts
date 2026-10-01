import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const end = vi.fn<() => Promise<void>>()
vi.mock('postgres', () => ({ default: vi.fn(() => ({ end })) }))
vi.mock('@project-vault/db/pg-tls', () => ({ pgTlsOptions: () => ({}) }))

const { runDbCheck } = await import('./run-db-check.js')

/**
 * `runDbCheck` is the entry point of four CLI integrity checks. It must own its whole async
 * lifecycle (Sonar typescript:S9383): callers get `void`, never a promise they could drop, and a
 * rejection anywhere (the check, `onError`, closing the connection) ends as a FATAL line plus a
 * non-zero exit code instead of an unhandled rejection.
 */
describe('runDbCheck', () => {
  let stdout: string[]
  let stderr: string[]

  beforeEach(() => {
    stdout = []
    stderr = []
    vi.stubEnv('DATABASE_URL', 'postgres://check-user@db.test:5432/vault')
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk))
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk))
      return true
    })
    end.mockReset().mockResolvedValue(undefined)
    process.exitCode = undefined
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    process.exitCode = undefined
  })

  it('returns void, not a promise a caller could leave floating', () => {
    const result: unknown = runDbCheck({
      check: async () => {},
      successMessage: 'ok',
      onError: () => {},
    })

    expect(result).toBeUndefined()
  })

  it('writes the success message and closes the connection when the check passes', async () => {
    runDbCheck({ check: async () => {}, successMessage: 'check: OK', onError: () => {} })

    await vi.waitFor(() => expect(end).toHaveBeenCalledOnce())
    expect(stdout).toEqual(['check: OK\n'])
    expect(process.exitCode).toBeUndefined()
  })

  it('hands a failing check to onError, exits non-zero and still closes the connection', async () => {
    const onError = vi.fn()
    const failure = new Error('gap found')

    runDbCheck({
      check: async () => {
        throw failure
      },
      successMessage: 'never',
      onError,
    })

    await vi.waitFor(() => expect(end).toHaveBeenCalledOnce())
    expect(onError).toHaveBeenCalledWith(failure)
    expect(stdout).toEqual([])
    expect(process.exitCode).toBe(1)
  })

  it('turns a rejection while closing the connection into a FATAL line, not an unhandled rejection', async () => {
    end.mockRejectedValue(new Error('connection reset'))

    runDbCheck({ check: async () => {}, successMessage: 'check: OK', onError: () => {} })

    await vi.waitFor(() => expect(process.exitCode).toBe(1))
    expect(stderr.join('')).toContain('FATAL: connection reset')
  })

  it('turns an onError that throws into a FATAL line and a non-zero exit', async () => {
    runDbCheck({
      check: async () => {
        throw new Error('gap found')
      },
      successMessage: 'never',
      onError: () => {
        throw new Error('formatter broke')
      },
    })

    await vi.waitFor(() => expect(stderr.join('')).toContain('FATAL: formatter broke'))
    expect(process.exitCode).toBe(1)
    expect(end).toHaveBeenCalledOnce()
  })
})
