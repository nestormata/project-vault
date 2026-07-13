import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const DEFAULT_ADMIN_DATABASE_URL = 'postgresql://postgres:password@localhost:5432/project_vault'
const CUSTOM_ADMIN_DATABASE_URL = 'postgresql://custom:custom@example.invalid:5432/custom_db'

const postgresMock = vi.fn((_url: string) => ({ __brand: 'postgres-client' }))
const drizzleMock = vi.fn((_client: unknown) => ({ __brand: 'drizzle-instance' }))

vi.mock('postgres', () => ({
  default: (...args: [string]) => postgresMock(...args),
}))

vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: (...args: [unknown]) => drizzleMock(...args),
}))

const ORIGINAL_ADMIN_DATABASE_URL = process.env['ADMIN_DATABASE_URL']

describe('getAdminDb', () => {
  beforeEach(() => {
    vi.resetModules()
    postgresMock.mockClear()
    drizzleMock.mockClear()
  })

  afterEach(() => {
    if (ORIGINAL_ADMIN_DATABASE_URL === undefined) {
      delete process.env['ADMIN_DATABASE_URL']
    } else {
      process.env['ADMIN_DATABASE_URL'] = ORIGINAL_ADMIN_DATABASE_URL
    }
  })

  it('uses ADMIN_DATABASE_URL when it is set', async () => {
    process.env['ADMIN_DATABASE_URL'] = CUSTOM_ADMIN_DATABASE_URL

    const { getAdminDb } = await import('./db.js')

    expect(() => getAdminDb()).not.toThrow()
    const result = getAdminDb()
    expect(result).toBeTruthy()
    expect(postgresMock).toHaveBeenCalledWith(CUSTOM_ADMIN_DATABASE_URL)
    expect(drizzleMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to the default local URL when ADMIN_DATABASE_URL is unset', async () => {
    delete process.env['ADMIN_DATABASE_URL']

    const { getAdminDb } = await import('./db.js')

    expect(() => getAdminDb()).not.toThrow()
    const result = getAdminDb()
    expect(result).toBeTruthy()
    expect(postgresMock).toHaveBeenCalledWith(DEFAULT_ADMIN_DATABASE_URL)
    expect(drizzleMock).toHaveBeenCalledTimes(1)
  })
})
