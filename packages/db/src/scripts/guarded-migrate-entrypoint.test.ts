import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { applyMigrations, isInvokedScript, main, runIfInvokedScript } from './guarded-migrate.js'

const mocks = vi.hoisted(() => {
  const end = vi.fn(async () => undefined)
  return {
    end,
    postgres: vi.fn(() =>
      Object.assign(
        () => Promise.resolve([{ rolname: 'postgres', rolsuper: true, rolbypassrls: false }]),
        { end }
      )
    ),
    drizzle: vi.fn(() => ({ kind: 'drizzle-db' }) as const),
    migrate: vi.fn(async () => undefined),
  }
})

vi.mock('postgres', () => ({ default: mocks.postgres }))
vi.mock('drizzle-orm/postgres-js', () => ({ drizzle: mocks.drizzle }))
vi.mock('drizzle-orm/postgres-js/migrator', () => ({ migrate: mocks.migrate }))

const DATABASE_URL = 'postgres://test'
const DRIZZLE_DB = { kind: 'drizzle-db' }

describe('guarded migration entrypoint', () => {
  it('recognizes a script invoked through a wrapper command', () => {
    const filename = '/workspace/packages/db/src/scripts/guarded-migrate.ts'
    expect(isInvokedScript(['/workspace/node_modules/tsx/cli.mjs', filename], filename)).toBe(true)
    expect(
      isInvokedScript(['/workspace/node_modules/tsx/cli.mjs', 'other-script.ts'], filename)
    ).toBe(false)
  })

  // Story 64.3: migrations are applied by drizzle-orm's own migrator (the code path
  // `drizzle-kit migrate` delegates to), so the published migrate image ships no drizzle-kit,
  // tsx or esbuild toolchain.
  it('applies the migrations folder through drizzle-orm and always closes the connection', async () => {
    mocks.end.mockClear()
    await applyMigrations(DATABASE_URL, '/workspace/packages/db/src/migrations')
    expect(mocks.postgres).toHaveBeenCalledWith(
      DATABASE_URL,
      expect.objectContaining({ max: 1, onnotice: expect.any(Function) })
    )
    expect(mocks.migrate).toHaveBeenCalledWith(DRIZZLE_DB, {
      migrationsFolder: '/workspace/packages/db/src/migrations',
    })
    expect(mocks.end).toHaveBeenCalledTimes(1)
  })

  it('closes the connection even when the migrator fails', async () => {
    mocks.end.mockClear()
    mocks.migrate.mockRejectedValueOnce(new Error('boom'))
    await expect(applyMigrations(DATABASE_URL, '/migrations')).rejects.toThrow('boom')
    expect(mocks.end).toHaveBeenCalledTimes(1)
  })

  it('completes the migration path after reading the last applied migration', async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL
    process.env.DATABASE_URL = DATABASE_URL
    try {
      await main()
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previousDatabaseUrl
    }
    expect(mocks.postgres).toHaveBeenCalledWith(DATABASE_URL, { max: 1 })
    expect(mocks.migrate).toHaveBeenCalledWith(DRIZZLE_DB, {
      migrationsFolder: resolve(import.meta.dirname, '../migrations'),
    })
  })

  it('sets a non-zero exit code and reports the error when the migrator fails', async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL
    const previousExitCode = process.exitCode
    process.env.DATABASE_URL = DATABASE_URL
    mocks.migrate.mockRejectedValueOnce(new Error('relation already exists'))
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      await main()
      expect(process.exitCode).toBe(1)
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('FATAL: migration failed: relation already exists')
      )
    } finally {
      stderr.mockRestore()
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = previousDatabaseUrl
      process.exitCode = previousExitCode
    }
  })

  it('runs the entrypoint only when the script appears in wrapped argv', async () => {
    const run = vi.fn(async () => undefined)
    const filename = resolve('guarded-migrate.ts')
    await runIfInvokedScript(['wrapper.mjs', filename], filename, run)
    await runIfInvokedScript(['wrapper.mjs', 'other.ts'], filename, run)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('converts an entrypoint failure into a non-zero process exit', async () => {
    const previousExitCode = process.exitCode
    const filename = resolve('guarded-migrate.ts')
    try {
      await runIfInvokedScript([filename], filename, async () => {
        throw new Error('migration failed')
      })
      expect(process.exitCode).toBe(1)
    } finally {
      process.exitCode = previousExitCode
    }
  })
})
