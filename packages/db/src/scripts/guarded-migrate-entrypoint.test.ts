import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import {
  isInvokedScript,
  main,
  resolveDrizzleKitExecutable,
  runDrizzleKitMigration,
  runIfInvokedScript,
} from './guarded-migrate.js'

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  postgres: vi.fn(() => {
    const sql = Object.assign(
      () => Promise.resolve([{ rolname: 'postgres', rolsuper: true, rolbypassrls: false }]),
      {
        end: vi.fn(async () => undefined),
      }
    )
    return sql
  }),
}))

vi.mock('node:child_process', () => ({ execFileSync: mocks.execFileSync }))
vi.mock('postgres', () => ({ default: mocks.postgres }))

const DATABASE_URL = 'postgres://test'

describe('guarded migration entrypoint', () => {
  it('resolves drizzle-kit from the fixed workspace dependency path', () => {
    expect(resolveDrizzleKitExecutable('/workspace/packages/db/src/scripts')).toBe(
      resolve('/workspace/packages/db/node_modules/drizzle-kit/bin.cjs')
    )
  })

  it('recognizes a script invoked through a wrapper command', () => {
    const filename = '/workspace/packages/db/src/scripts/guarded-migrate.ts'
    expect(isInvokedScript(['/workspace/node_modules/tsx/cli.mjs', filename], filename)).toBe(true)
    expect(
      isInvokedScript(['/workspace/node_modules/tsx/cli.mjs', 'other-script.ts'], filename)
    ).toBe(false)
  })

  it('runs drizzle-kit from the fixed executable path', () => {
    runDrizzleKitMigration('/workspace/packages/db/src/scripts')
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      '/workspace/packages/db/node_modules/drizzle-kit/bin.cjs',
      ['migrate'],
      { stdio: 'inherit', cwd: '/workspace/packages/db' }
    )
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
    expect(mocks.execFileSync).toHaveBeenCalled()
  })

  it('sets a non-zero exit code when drizzle-kit fails', async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL
    const previousExitCode = process.exitCode
    process.env.DATABASE_URL = DATABASE_URL
    mocks.execFileSync.mockImplementationOnce(() => {
      throw new Error('drizzle-kit failed')
    })
    try {
      await main()
      expect(process.exitCode).toBe(1)
    } finally {
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
